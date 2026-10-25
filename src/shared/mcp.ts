// Client MCP minimal (lecture seule) : liste des outils d'un serveur MCP, interrogé directement
// (le serveur opencode n'expose pas ces outils). Local : la commande est lancée le temps de la
// requête (JSON-RPC sur stdio) ; distant : transport « Streamable HTTP » (réponse JSON ou SSE).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import * as z from 'zod/mini';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish_utf8');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async', 'write_all_finish');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const PROTOCOL = '2025-06-18';
const TIMEOUT_MS = 20_000;
/** pages de `tools/list` lues au plus (pagination par curseur) */
const MAX_PAGES = 20;

export const McpTool = z.looseObject({
  name: z.string(),
  title: z.optional(z.string()),
  description: z.optional(z.string()),
  inputSchema: z.optional(z.unknown()),
});
export type McpTool = z.output<typeof McpTool>;

const ToolsResult = z.looseObject({ tools: z.array(McpTool), nextCursor: z.optional(z.nullable(z.string())) });
const RpcResponse = z.looseObject({
  id: z.optional(z.union([z.number(), z.string(), z.null()])),
  result: z.optional(z.unknown()),
  error: z.optional(z.looseObject({ code: z.optional(z.number()), message: z.string() })),
});

/** Serveur MCP tel que déclaré dans la configuration opencode. */
export interface McpServer {
  readonly type?: string | undefined;
  readonly command?: readonly string[] | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly url?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** Paramètre d'un outil, aplati depuis son schéma JSON. */
export interface ToolParam {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
}

const AnyRecord = z.record(z.string(), z.unknown());
const record = (v: unknown): Record<string, unknown> | null => {
  const r = z.safeParse(AnyRecord, v);
  return r.success ? r.data : null;
};

/** Type lisible d'un schéma JSON (`string`, `number[]`, `"a" | "b"`, `object`…). */
function typeOf(schema: unknown): string {
  const s = record(schema);
  if (s === null) return '';
  if (Array.isArray(s['enum'])) return s['enum'].map((v) => JSON.stringify(v)).join(' | ');
  if (s['const'] !== undefined) return JSON.stringify(s['const']);
  for (const key of ['anyOf', 'oneOf']) {
    const list = s[key];
    if (Array.isArray(list)) return [...new Set(list.map((x) => typeOf(x)).filter((t) => t !== ''))].join(' | ');
  }
  const t = s['type'];
  if (Array.isArray(t)) return t.join(' | ');
  if (t === 'array') {
    const inner = typeOf(s['items']);
    return inner === '' ? 'array' : inner.includes(' ') ? `(${inner})[]` : `${inner}[]`;
  }
  return typeof t === 'string' ? t : '';
}

/** Paramètres de premier niveau d'un outil (`inputSchema.properties`). */
export function toolParams(tool: McpTool): ToolParam[] {
  const schema = record(tool.inputSchema);
  const props = record(schema?.['properties']);
  if (props === null) return [];
  const required = new Set(Array.isArray(schema?.['required']) ? schema['required'].filter((r): r is string => typeof r === 'string') : []);
  return Object.entries(props).map(([name, p]) => {
    const prop = record(p);
    const desc = typeof prop?.['description'] === 'string' ? prop['description'] : '';
    const def = prop?.['default'] === undefined ? '' : `défaut : ${JSON.stringify(prop['default'])}`;
    return { name, type: typeOf(p), required: required.has(name), description: [desc, def].filter((x) => x !== '').join(' — ') };
  });
}

// ------------------------------------------------------------------ JSON-RPC

interface Transport {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  close(): void;
}

const INIT = { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'opencode-gnome', version: '1' } };

function rpcResult(msg: unknown, method: string): unknown {
  const r = z.parse(RpcResponse, msg);
  if (r.error !== undefined) throw new Error(`${method} : ${r.error.message}`);
  return r.result;
}

/** MCP local : la commande est lancée dans le dossier du projet, messages JSON ligne à ligne. */
function stdioTransport(server: McpServer, directory: string): Transport {
  const [cmd, ...args] = server.command ?? [];
  if (cmd === undefined) throw new Error('commande absente de la configuration');
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE });
  launcher.set_cwd(directory);
  for (const [k, v] of Object.entries(server.environment ?? {})) launcher.setenv(k, v, true);
  const proc = launcher.spawnv([cmd, ...args]);
  const stdin = proc.get_stdin_pipe();
  const stdoutPipe = proc.get_stdout_pipe();
  if (stdin === null || stdoutPipe === null) throw new Error('tubes du processus indisponibles');
  const stdout = new Gio.DataInputStream({ baseStream: stdoutPipe });
  const cancellable = new Gio.Cancellable();
  let nextId = 1;
  const send = async (msg: unknown): Promise<void> => {
    await stdin.write_all_async(new TextEncoder().encode(`${JSON.stringify(msg)}\n`), GLib.PRIORITY_DEFAULT, cancellable);
  };
  return {
    async request(method, params) {
      const id = nextId++;
      await send({ jsonrpc: '2.0', id, method, params });
      // les notifications et requêtes du serveur (journaux…) sont ignorées
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- lecture ligne à ligne jusqu'à la réponse
        const [bytes] = await stdout.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
        if (bytes === null) throw new Error('le serveur MCP s\'est arrêté sans répondre');
        const line = new TextDecoder().decode(bytes);
        if (line.trim() === '') continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // ligne qui n'est pas du JSON-RPC (sortie parasite)
        }
        if (record(msg)?.['id'] === id) return rpcResult(msg, method);
      }
    },
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    close() {
      cancellable.cancel();
      proc.force_exit();
    },
  };
}

/** Messages JSON-RPC d'un flux SSE (`data: …`). */
function sseMessages(text: string): unknown[] {
  const out: unknown[] = [];
  for (const event of text.split(/\r?\n\r?\n/u)) {
    const data = event
      .split(/\r?\n/u)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (data === '') continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // événement illisible : ignoré
    }
  }
  return out;
}

/** MCP distant, transport « Streamable HTTP ». */
function httpTransport(server: McpServer): Transport {
  const url = server.url;
  if (url === undefined) throw new Error('URL absente de la configuration');
  const session = new Soup.Session({ timeout: TIMEOUT_MS / 1000 });
  let sessionId: string | null = null;
  let nextId = 1;
  const post = async (body: unknown, method: string): Promise<{ status: number; text: string; type: string }> => {
    const msg = Soup.Message.new('POST', url);
    if (msg === null) throw new Error(`URL invalide : ${url}`);
    const h = msg.get_request_headers();
    h.replace('Accept', 'application/json, text/event-stream');
    h.replace('MCP-Protocol-Version', PROTOCOL);
    if (sessionId !== null) h.replace('Mcp-Session-Id', sessionId);
    for (const [k, v] of Object.entries(server.headers ?? {})) h.replace(k, v);
    msg.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
    const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    const data = bytes.get_data();
    const text = data === null ? '' : new TextDecoder().decode(data);
    const status: number = msg.get_status();
    sessionId = msg.get_response_headers().get_one('Mcp-Session-Id') ?? sessionId;
    if (status === 401 || status === 403) throw new Error(`${method} : accès refusé (HTTP ${status}) — authentification requise (OAuth ou clé)`);
    if (status < 200 || status >= 300) throw new Error(`${method} : HTTP ${status} ${text.slice(0, 200)}`);
    return { status, text, type: msg.get_response_headers().get_content_type()[0] ?? '' };
  };
  return {
    async request(method, params) {
      const id = nextId++;
      const { text, type } = await post({ jsonrpc: '2.0', id, method, params }, method);
      const messages = type === 'text/event-stream' ? sseMessages(text) : [JSON.parse(text) as unknown];
      const reply = messages.find((m) => record(m)?.['id'] === id);
      if (reply === undefined) throw new Error(`${method} : pas de réponse du serveur MCP`);
      return rpcResult(reply, method);
    },
    async notify(method, params) {
      await post({ jsonrpc: '2.0', method, params }, method);
    },
    close() {
      session.abort();
    },
  };
}

/** Outils d'un serveur MCP, interrogé directement. `directory` : dossier de lancement d'un MCP local. */
export async function listMcpTools(server: McpServer, directory: string): Promise<McpTool[]> {
  const transport = server.type === 'remote' || (server.url !== undefined && server.command === undefined) ? httpTransport(server) : stdioTransport(server, directory);
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TIMEOUT_MS, () => {
      timer = 0;
      reject(new Error(`pas de réponse après ${TIMEOUT_MS / 1000} s`));
      return GLib.SOURCE_REMOVE;
    });
  });
  const work = async (): Promise<McpTool[]> => {
    await transport.request('initialize', INIT);
    await transport.notify('notifications/initialized', {});
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      // oxlint-disable-next-line no-await-in-loop -- pages successives (curseur)
      const r = z.parse(ToolsResult, await transport.request('tools/list', cursor === undefined ? {} : { cursor }));
      tools.push(...r.tools);
      if (r.nextCursor === undefined || r.nextCursor === null || r.nextCursor === '') break;
      cursor = r.nextCursor;
    }
    return tools;
  };
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer !== 0) GLib.source_remove(timer);
    transport.close();
  }
}
