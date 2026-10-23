// Client HTTP + SSE pour `opencode serve`, basé sur libsoup 3 (GJS, sans Node).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import * as z from 'zod/mini';
import { errorMessage, HttpError } from './errors.ts';
import { Agent, AppEvent, type Attachment, Command, FileDiff, type Mention, SharedSession, GlobalEnvelope, Health, MessageWithParts, OpencodeConfig, PermissionRequest, Providers, QuestionRequest, VcsInfo, Project, Session, SessionStatus, Todo, type AppEventEnvelope } from './schemas.ts';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Soup.Session.prototype, 'send_async', 'send_finish');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish');

type Query = Readonly<Record<string, string | number | boolean | undefined>>;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Types de fichiers que les modèles lisent directement en pièce jointe. */
export const isModelReadable = (mime: string): boolean =>
  mime.startsWith('image/') || mime === 'application/pdf' || mime.startsWith('text/') || mime === 'application/json';

export interface PromptOptions {
  agent?: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
  files?: readonly Attachment[];
  mentions?: readonly Mention[];
}

/** Parties `file` des mentions `@chemin`, au format de la TUI (le serveur lit le fichier ou liste le dossier). */
const mentionParts = (directory: string, mentions: readonly Mention[]): object[] =>
  mentions.map((m) => ({
    type: 'file',
    mime: m.directory ? 'application/x-directory' : 'text/plain',
    filename: m.path,
    url: GLib.filename_to_uri(GLib.build_filenamev([directory, m.path]), null),
    source: { type: 'file', path: m.path, text: { value: `@${m.path}`, start: m.start, end: m.end } },
  }));

export class OpencodeClient {
  readonly url: string;
  readonly #session = new Soup.Session({ timeout: 30 });
  /** Session dédiée au flux SSE : pas de timeout. */
  readonly #stream = new Soup.Session({ timeout: 0, idleTimeout: 0 });

  constructor(url: string) {
    this.url = url.replace(/\/+$/u, '');
  }

  #uri(path: string, query: Query = {}): string {
    const params = Object.entries(query)
      .filter((e): e is [string, string | number | boolean] => e[1] !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    return `${this.url}${path}${params.length > 0 ? `?${params.join('&')}` : ''}`;
  }

  async request<S extends z.ZodMiniType>(
    method: string,
    path: string,
    schema: S,
    opts: { query?: Query; body?: unknown; long?: boolean; cancellable?: Gio.Cancellable } = {},
  ): Promise<z.output<S>> {
    const msg = Soup.Message.new(method, this.#uri(path, opts.query));
    if (msg === null) throw new Error(`URL invalide : ${this.url}${path}`);
    if (opts.body !== undefined) {
      msg.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(JSON.stringify(opts.body))));
    }
    const session = opts.long === true ? this.#stream : this.#session;
    const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, opts.cancellable ?? null);
    const data = bytes.get_data();
    const text = data === null ? '' : decoder.decode(data);
    const status: number = msg.get_status();
    if (status < 200 || status >= 300) throw new HttpError(status, `${method} ${path} : HTTP ${status} ${text.slice(0, 200)}`);
    return z.parse(schema, text === '' ? null : JSON.parse(text));
  }

  get<S extends z.ZodMiniType>(path: string, schema: S, query?: Query): Promise<z.output<S>> {
    return this.request('GET', path, schema, query === undefined ? {} : { query });
  }

  // ------------------------------------------------------------------ API

  health(): Promise<Health> {
    return this.get('/global/health', Health);
  }

  projects(): Promise<Project[]> {
    return this.get('/project', z.array(Project));
  }

  /** Sessions racines (sans les sous-agents) de tous les projets, les plus récentes d'abord. */
  sessions(limit = 500): Promise<Session[]> {
    return this.get('/experimental/session', z.array(Session), { roots: true, limit });
  }

  /** Statut des sessions actives (les sessions absentes sont au repos). */
  statuses(directory?: string): Promise<Record<string, SessionStatus>> {
    return this.get('/session/status', z.record(z.string(), SessionStatus), directory === undefined ? {} : { directory });
  }

  /** Derniers messages d'une session (ordre chronologique). */
  messages(sessionID: string, limit = 200): Promise<MessageWithParts[]> {
    return this.get(`/session/${encodeURIComponent(sessionID)}/message`, z.array(MessageWithParts), { limit });
  }

  /** Liste de tâches de la session (outil `todowrite`). */
  todos(sessionID: string, directory: string): Promise<Todo[]> {
    return this.get(`/session/${encodeURIComponent(sessionID)}/todo`, z.array(Todo), { directory });
  }

  createSession(directory: string): Promise<Session> {
    return this.request('POST', '/session', Session, { query: { directory }, body: {} });
  }

  renameSession(sessionID: string, directory: string, title: string): Promise<Session> {
    return this.request('PATCH', `/session/${encodeURIComponent(sessionID)}`, Session, { query: { directory }, body: { title } });
  }

  /** Copie une session (entière, ou jusqu'à `messageID`) dans une nouvelle session. */
  forkSession(sessionID: string, directory: string, messageID?: string): Promise<Session> {
    return this.request('POST', `/session/${encodeURIComponent(sessionID)}/fork`, Session, {
      query: { directory },
      body: messageID === undefined ? {} : { messageID },
    });
  }

  async deleteSession(sessionID: string, directory: string): Promise<void> {
    await this.request('DELETE', `/session/${encodeURIComponent(sessionID)}`, z.unknown(), { query: { directory } });
  }

  /** Envoie un prompt sans attendre la réponse (elle arrive par le flux d'événements). */
  async prompt(sessionID: string, directory: string, text: string, opts: PromptOptions = {}): Promise<void> {
    const { files = [], mentions = [], ...rest } = opts;
    // Les fournisseurs refusent les types non pris en charge (xlsx, zip…), et l'erreur se répète
    // à chaque tour car la pièce jointe reste dans l'historique : ces fichiers sont transmis par
    // leur chemin, l'agent les ouvre avec ses outils.
    const direct = files.filter((f) => isModelReadable(f.mime) || !f.url.startsWith('file://'));
    const byPath = files.filter((f) => !direct.includes(f));
    const paths = byPath.map((f) => `- ${decodeURIComponent(f.url.slice('file://'.length))}`);
    const fullText = paths.length === 0 ? text : `${text}${text === '' ? '' : '\n\n'}Fichiers joints :\n${paths.join('\n')}`;
    const parts = [
      ...(fullText === '' ? [] : [{ type: 'text', text: fullText }]),
      ...direct.map((f) => ({ type: 'file', mime: f.mime, filename: f.filename, url: f.url })),
      ...mentionParts(directory, mentions),
    ];
    await this.request('POST', `/session/${encodeURIComponent(sessionID)}/prompt_async`, z.unknown(), {
      query: { directory },
      body: { parts, ...rest },
    });
  }

  /** Commandes disponibles dans le répertoire (serveur, utilisateur, projet, skills, MCP). */
  commands(directory: string): Promise<Command[]> {
    return this.get('/command', z.array(Command), { directory });
  }

  /**
   * Exécute une commande comme la TUI. La requête ne répond qu'à la fin du tour de l'agent :
   * session HTTP sans délai d'expiration, la progression arrive par le flux d'événements.
   */
  async command(sessionID: string, directory: string, command: string, args: string, opts: PromptOptions = {}): Promise<void> {
    const { files = [], mentions = [], model, ...rest } = opts;
    const parts = [...files.map((f) => ({ type: 'file', mime: f.mime, filename: f.filename, url: f.url })), ...mentionParts(directory, mentions)];
    await this.request('POST', `/session/${encodeURIComponent(sessionID)}/command`, z.unknown(), {
      query: { directory },
      body: { command, arguments: args, ...rest, ...(model === undefined ? {} : { model: `${model.providerID}/${model.modelID}` }), ...(parts.length === 0 ? {} : { parts }) },
      long: true,
    });
  }

  /** Compacte la session (résumé par le modèle donné), comme `/compact`. */
  async summarize(sessionID: string, directory: string, model: { providerID: string; modelID: string }): Promise<void> {
    await this.request('POST', `/session/${encodeURIComponent(sessionID)}/summarize`, z.unknown(), { query: { directory }, body: model, long: true });
  }

  /** Annule les messages à partir de `messageID` (et les modifications de fichiers associées). */
  async revert(sessionID: string, directory: string, messageID: string): Promise<void> {
    await this.request('POST', `/session/${encodeURIComponent(sessionID)}/revert`, z.unknown(), { query: { directory }, body: { messageID } });
  }

  /** Rétablit tous les messages annulés. */
  async unrevert(sessionID: string, directory: string): Promise<void> {
    await this.request('POST', `/session/${encodeURIComponent(sessionID)}/unrevert`, z.unknown(), { query: { directory } });
  }

  /** Partage la session ; retourne le lien public. */
  async share(sessionID: string, directory: string): Promise<string | null> {
    const s = await this.request('POST', `/session/${encodeURIComponent(sessionID)}/share`, SharedSession, { query: { directory } });
    return s.share?.url ?? null;
  }

  async unshare(sessionID: string, directory: string): Promise<void> {
    await this.request('DELETE', `/session/${encodeURIComponent(sessionID)}/share`, z.unknown(), { query: { directory } });
  }

  /** Recherche floue de fichiers (ou dossiers) du répertoire, triée par pertinence, `.gitignore` respecté. */
  findFiles(directory: string, query: string, opts: { type?: 'file' | 'directory'; limit?: number; cancellable?: Gio.Cancellable } = {}): Promise<string[]> {
    const { cancellable, ...rest } = opts;
    return this.request('GET', '/find/file', z.array(z.string()), { query: { directory, query, ...rest }, ...(cancellable === undefined ? {} : { cancellable }) });
  }

  async abort(sessionID: string, directory: string): Promise<void> {
    await this.request('POST', `/session/${encodeURIComponent(sessionID)}/abort`, z.unknown(), { query: { directory } });
  }

  permissions(directory: string): Promise<PermissionRequest[]> {
    return this.get('/permission', z.array(PermissionRequest), { directory });
  }

  async replyPermission(requestID: string, directory: string, reply: 'once' | 'always' | 'reject'): Promise<void> {
    await this.request('POST', `/permission/${encodeURIComponent(requestID)}/reply`, z.unknown(), { query: { directory }, body: { reply } });
  }

  questions(directory: string): Promise<QuestionRequest[]> {
    return this.get('/question', z.array(QuestionRequest), { directory });
  }

  /** Une réponse par question : la liste des libellés choisis (ou saisis). */
  async replyQuestion(requestID: string, directory: string, answers: string[][]): Promise<void> {
    await this.request('POST', `/question/${encodeURIComponent(requestID)}/reply`, z.unknown(), { query: { directory }, body: { answers } });
  }

  async rejectQuestion(requestID: string, directory: string): Promise<void> {
    await this.request('POST', `/question/${encodeURIComponent(requestID)}/reject`, z.unknown(), { query: { directory } });
  }

  agents(directory: string): Promise<Agent[]> {
    return this.get('/agent', z.array(Agent), { directory });
  }

  config(directory: string): Promise<OpencodeConfig> {
    return this.get('/config', OpencodeConfig, { directory });
  }

  providers(directory: string): Promise<Providers> {
    return this.get('/config/providers', Providers, { directory });
  }

  /** Fichiers modifiés de l'arbre de travail git du répertoire (indexés ou non, nouveaux fichiers compris). */
  gitDiff(directory: string): Promise<FileDiff[]> {
    return this.get('/vcs/diff', z.array(FileDiff), { directory, mode: 'git' });
  }

  vcs(directory: string): Promise<VcsInfo> {
    return this.get('/vcs', VcsInfo, { directory });
  }

  // ------------------------------------------------------------------ SSE

  /**
   * Écoute `GET /global/event` (tous les projets) et reconnecte automatiquement.
   * `onState(true)` à chaque connexion : l'appelant doit alors recharger l'état complet.
   * Retourne une fonction d'arrêt.
   */
  listen(onEvent: (e: AppEventEnvelope) => void, onState: (connected: boolean, error?: string) => void): () => void {
    const cancellable = new Gio.Cancellable();
    let retry = 0;

    // une connexion, puis reconnexion après un délai croissant (1 à 5 s)
    const connect = async (): Promise<void> => {
      try {
        await this.#readStream(cancellable, onEvent, () => {
          retry = 0;
          onState(true);
        });
        onState(false, 'flux interrompu');
      } catch (e) {
        if (cancellable.is_cancelled()) return;
        onState(false, errorMessage(e));
      }
      retry = Math.min(retry + 1, 5);
      await sleep(retry * 1000, cancellable);
      if (!cancellable.is_cancelled()) void connect();
    };
    void connect();
    return () => cancellable.cancel();
  }

  async #readStream(cancellable: Gio.Cancellable, onEvent: (e: AppEventEnvelope) => void, onOpen: () => void): Promise<void> {
    const msg = Soup.Message.new('GET', this.#uri('/global/event'));
    if (msg === null) throw new Error(`URL invalide : ${this.url}`);
    msg.get_request_headers().append('Accept', 'text/event-stream');
    const input = await this.#stream.send_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
    const status: number = msg.get_status();
    if (status !== 200) throw new HttpError(status, `/global/event : HTTP ${status}`);
    onOpen();
    const lines = new Gio.DataInputStream({ baseStream: input, closeBaseStream: true });
    let data: string[] = [];
    try {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- lecture séquentielle d'un flux SSE
        const [bytes] = await lines.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
        if (bytes === null) return; // fin du flux
        const line = decoder.decode(bytes).replace(/\r$/u, '');
        if (line === '') {
          if (data.length > 0) dispatch(data.join('\n'), onEvent);
          data = [];
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).trimStart());
        }
      }
    } finally {
      lines.close(null);
    }
  }
}

function dispatch(raw: string, onEvent: (e: AppEventEnvelope) => void): void {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return;
  }
  const env = GlobalEnvelope.safeParse(json);
  if (!env.success) return;
  const ev = AppEvent.safeParse(env.data.payload);
  if (!ev.success) return; // événement non utilisé par l'app
  onEvent({ directory: env.data.directory ?? null, event: ev.data });
}

function sleep(ms: number, cancellable: Gio.Cancellable): Promise<void> {
  return new Promise((resolve) => {
    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      cancellable.disconnect(handler);
      resolve();
      return GLib.SOURCE_REMOVE;
    });
    const handler = cancellable.connect(() => {
      GLib.source_remove(id);
      resolve();
    });
  });
}
