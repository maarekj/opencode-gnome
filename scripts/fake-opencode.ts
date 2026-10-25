// Faux serveur opencode pour les tests de bout en bout : imite les routes HTTP et le flux
// d'événements (`/global/event`) utilisés par l'application, à partir d'un scénario JSON.
// Aucun modèle n'est appelé : un prompt reçoit une réponse simulée (« Réponse simulée : … »).
//
// Usage : node scripts/fake-opencode.ts [--port 4790] [--scenario fichier.json]
// Pilotage par le test (préfixe /__test) :
//   GET  /__test/requests          requêtes reçues (méthode, chemin, requête, corps), dans l'ordre
//   POST /__test/emit              émet un événement : { directory?, payload: { type, properties } }
//   POST /__test/scenario          remplace l'état par un nouveau scénario
//   POST /__test/reset             vide le journal des requêtes
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as z from 'zod/mini';

// ---------------------------------------------------------------- données

type Json = Record<string, unknown>;

const isJson = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown): Json => (isJson(v) ? v : {});
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x) => isJson(x)) : []);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

const Entity = z.looseObject({ id: z.string() });
const Message = z.object({ info: z.looseObject({ id: z.string(), role: z.string(), sessionID: z.string() }), parts: z.array(z.looseObject({ id: z.string(), type: z.string() })) });
type Message = z.output<typeof Message>;

/** Scénario : état initial du faux serveur. */
const Scenario = z.object({
  /** projets : `{ id, worktree, name?, vcs? }` */
  projects: z.optional(z.array(z.looseObject({ id: z.string(), worktree: z.string() }))),
  /** sessions (racines et sous-agents) : `{ id, projectID, directory, title, … }` */
  sessions: z.optional(z.array(z.looseObject({ id: z.string(), directory: z.string(), title: z.string() }))),
  /** messages par session, du plus ancien au plus récent */
  messages: z.optional(z.record(z.string(), z.array(Message))),
  /** statut des sessions actives : `{ ses_x: { type: 'busy' } }` */
  statuses: z.optional(z.record(z.string(), z.looseObject({ type: z.string() }))),
  permissions: z.optional(z.array(Entity)),
  questions: z.optional(z.array(Entity)),
  /** `{ nom: { status } }` */
  mcp: z.optional(z.record(z.string(), z.looseObject({ status: z.string() }))),
  /** configuration (`GET /config`, fusion projet + global) */
  config: z.optional(z.looseObject({})),
  /** configuration globale seule (`GET /global/config`) ; défaut : `config` */
  globalConfig: z.optional(z.looseObject({})),
  agents: z.optional(z.array(z.looseObject({ name: z.string() }))),
  providers: z.optional(z.looseObject({})),
  commands: z.optional(z.array(z.looseObject({ name: z.string() }))),
  skills: z.optional(z.array(z.looseObject({ name: z.string() }))),
  /** fichiers modifiés de l'arbre de travail (`GET /vcs/diff`) : `{ file, status, additions, deletions, patch }` */
  vcsDiff: z.optional(z.array(z.looseObject({ file: z.string() }))),
  /** fichiers du projet pour la complétion `@` (`GET /find/file`) ; un dossier finit par `/` */
  files: z.optional(z.array(z.string())),
  /** liste de tâches par session (`GET /session/:id/todo`) */
  todos: z.optional(z.record(z.string(), z.array(z.looseObject({ content: z.string(), status: z.string() })))),
  /** requêtes qui échouent une fois (HTTP 500), ex. `GET /session/ses_a/message` */
  failOnce: z.optional(z.array(z.string())),
  /** réponse simulée envoyée après un prompt (`false` : aucune) */
  reply: z.optional(z.union([z.string(), z.literal(false)])),
});
type Scenario = z.output<typeof Scenario>;
type Ses = Json & { id: string; directory: string; title: string };

const DEFAULT_SCENARIO: Scenario = { projects: [{ id: 'prj_demo', worktree: '/tmp/opencode-fake/demo', name: 'demo', vcs: 'git' }] };

const DEFAULT_AGENTS = [
  { name: 'build', mode: 'primary', description: 'Agent par défaut' },
  { name: 'plan', mode: 'primary', description: 'Planification' },
  { name: 'general', mode: 'subagent', description: 'Sous-agent' },
];
const DEFAULT_PROVIDERS = {
  providers: [{ id: 'fake', name: 'Fournisseur simulé', models: { 'fake-model': { id: 'fake-model', name: 'Modèle simulé', limit: { context: 200_000 }, variants: { low: {}, high: {} } } } }],
  default: { fake: 'fake-model' },
};

// ---------------------------------------------------------------- état

class State {
  scenario: Scenario = {};
  readonly sessions = new Map<string, Ses>();
  readonly messages = new Map<string, Message[]>();
  permissions: Json[] = [];
  questions: Json[] = [];
  statuses: Record<string, Json> = {};
  mcp: Record<string, Json> = {};
  todos: Record<string, Json[]> = {};
  failOnce = new Set<string>();
  #seq = 0;

  load(s: Scenario): void {
    this.scenario = s;
    this.sessions.clear();
    this.messages.clear();
    for (const ses of s.sessions ?? []) this.sessions.set(ses.id, { time: { created: Date.now(), updated: Date.now() }, ...structuredClone(ses) });
    for (const [id, msgs] of Object.entries(s.messages ?? {})) this.messages.set(id, structuredClone(msgs));
    this.permissions = structuredClone(s.permissions ?? []);
    this.questions = structuredClone(s.questions ?? []);
    this.statuses = structuredClone(s.statuses ?? {});
    this.mcp = structuredClone(s.mcp ?? {});
    this.todos = structuredClone(s.todos ?? {});
    this.failOnce = new Set(s.failOnce ?? []);
  }

  /**
   * Identifiant croissant (l'app trie messages et parties par identifiant) ; « z » : après les
   * identifiants des scénarios (`msg_001`…).
   */
  id(prefix: string): string {
    this.#seq += 1;
    return `${prefix}_z${Date.now().toString(36).padStart(10, '0')}${this.#seq.toString(36).padStart(4, '0')}`;
  }

  projectOf(directory: string): Json | undefined {
    return (this.scenario.projects ?? []).find((p) => directory === p.worktree || directory.startsWith(`${p.worktree}/`));
  }
}

// ---------------------------------------------------------------- serveur

const args = parseArgs({ options: { port: { type: 'string', default: '4790' }, scenario: { type: 'string' } } });
const state = new State();
state.load(args.values.scenario === undefined ? DEFAULT_SCENARIO : z.parse(Scenario, JSON.parse(fs.readFileSync(path.resolve(args.values.scenario), 'utf8'))));
const requests: { method: string; path: string; query: Record<string, string>; body: unknown }[] = [];
const streams = new Set<http.ServerResponse>();

function emit(type: string, properties: unknown, directory: string | null = null): void {
  const data = `data: ${JSON.stringify({ directory, payload: { type, properties } })}\n\n`;
  for (const res of streams) res.write(data);
}

function send(res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

const notFound = (res: http.ServerResponse, what: string): void => {
  send(res, 404, { name: 'NotFoundError', data: { message: `${what} introuvable` } });
};

function touch(ses: Ses): void {
  ses['time'] = { ...obj(ses['time']), updated: Date.now() };
  emit('session.updated', { info: ses });
}

function setIdle(sessionID: string): void {
  delete state.statuses[sessionID];
  emit('session.status', { sessionID, status: { type: 'idle' } });
}

/** Réponse simulée à un prompt : message utilisateur, tour de l'assistant, puis repos. */
function simulateTurn(ses: Ses, text: string, body: Json): void {
  const msgs = state.messages.get(ses.id) ?? [];
  state.messages.set(ses.id, msgs);
  const model = obj(body['model']);
  const agent = str(body['agent'], 'build');
  const userID = state.id('msg');
  const user: Message = {
    info: { id: userID, role: 'user', sessionID: ses.id, time: { created: Date.now() }, agent, model },
    parts: [{ id: state.id('prt'), type: 'text', messageID: userID, sessionID: ses.id, text }],
  };
  msgs.push(user);
  emit('message.updated', { sessionID: ses.id, info: user.info });
  for (const p of user.parts) emit('message.part.updated', { sessionID: ses.id, part: p });
  const reply = state.scenario.reply;
  if (reply === false) return;
  state.statuses[ses.id] = { type: 'busy' };
  emit('session.status', { sessionID: ses.id, status: { type: 'busy' } });
  setTimeout(() => {
    const id = state.id('msg');
    const info = {
      id,
      role: 'assistant',
      sessionID: ses.id,
      parentID: userID,
      time: { created: Date.now(), completed: Date.now() + 1 },
      agent,
      providerID: str(model['providerID'], 'fake'),
      modelID: str(model['modelID'], 'fake-model'),
      tokens: { input: 100, output: 20, cache: { read: 0, write: 0 } },
      cost: 0,
    };
    const part = { id: state.id('prt'), type: 'text', messageID: id, sessionID: ses.id, text: reply ?? `Réponse simulée : ${text}` };
    msgs.push({ info, parts: [part] });
    emit('message.updated', { sessionID: ses.id, info });
    emit('message.part.updated', { sessionID: ses.id, part });
    setIdle(ses.id);
    emit('session.idle', { sessionID: ses.id });
    touch(ses);
  }, 300);
}

/** Appel d'outil lié à une demande : terminé (sortie simulée) ou en erreur (refus). */
function finishTool(request: Json, output: string | null): void {
  const tool = obj(request['tool']);
  const sid = str(request['sessionID']);
  const msg = (state.messages.get(sid) ?? []).find((x) => x.info.id === tool['messageID']);
  const part = msg?.parts.find((x) => x['callID'] === tool['callID']);
  if (part === undefined) return;
  const prev = obj(part['state']);
  part['state'] = output === null ? { ...prev, status: 'error', error: 'Permission refusée' } : { ...prev, status: 'completed', output };
  emit('message.part.updated', { sessionID: sid, part });
  setIdle(sid);
}

function finishQuestion(request: Json, answers: unknown): void {
  const tool = obj(request['tool']);
  const sid = str(request['sessionID']);
  const msg = (state.messages.get(sid) ?? []).find((x) => x.info.id === tool['messageID']);
  const part = msg?.parts.find((x) => x['callID'] === tool['callID']);
  if (part === undefined) return;
  const prev = obj(part['state']);
  part['state'] = answers === null ? { ...prev, status: 'error', error: 'The user dismissed this question' } : { ...prev, status: 'completed', metadata: { answers }, output: 'ok' };
  emit('message.part.updated', { sessionID: sid, part });
  setIdle(sid);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const c of req) if (c instanceof Uint8Array) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const textOf = (body: Json): string =>
  list(body['parts'])
    .filter((p) => p['type'] === 'text')
    .map((p) => str(p['text']))
    .join('\n');

const updatedOf = (s: Json): number => num(obj(s['time'])['updated']);

/** Routes de pilotage du test ; true si la requête a été traitée. */
function handleTest(p: string, b: Json, res: http.ServerResponse): boolean {
  switch (p) {
    case '/__test/requests':
      send(res, 200, requests);
      return true;
    case '/__test/reset':
      requests.length = 0;
      send(res, 200, true);
      return true;
    case '/__test/emit': {
      const payload = obj(b['payload']);
      emit(str(payload['type']), payload['properties'], typeof b['directory'] === 'string' ? b['directory'] : null);
      send(res, 200, true);
      return true;
    }
    case '/__test/scenario':
      state.load(z.parse(Scenario, b));
      send(res, 200, true);
      return true;
    default:
      return false;
  }
}

/** Routes en lecture simple ; la valeur renvoyée, ou undefined si la route n'est pas connue. */
function simpleRoute(p: string, query: Record<string, string>): unknown {
  const s = state.scenario;
  switch (p) {
    case '/global/health':
      return { healthy: true, version: 'fake' };
    case '/project':
      return s.projects ?? [];
    case '/agent':
      return s.agents ?? DEFAULT_AGENTS;
    case '/config/providers':
      return s.providers ?? DEFAULT_PROVIDERS;
    case '/config':
      return s.config ?? {};
    case '/global/config':
      return s.globalConfig ?? s.config ?? {};
    case '/command':
      return s.commands ?? [];
    case '/skill':
      return s.skills ?? [];
    case '/mcp':
      return state.mcp;
    case '/vcs':
      return { branch: 'main' };
    case '/vcs/diff':
      return s.vcsDiff ?? [];
    case '/find/file': {
      // comme opencode : correspondance approximative sur le chemin, dossiers avec `type=directory`
      const q = (query['query'] ?? '').toLowerCase();
      const dirs = query['type'] === 'directory';
      return (s.files ?? [])
        .filter((f) => f.endsWith('/') === dirs && f.toLowerCase().includes(q))
        .slice(0, Number(query['limit'] ?? 20));
    }
    case '/instance/dispose':
      return true;
    case '/permission':
      return state.permissions;
    case '/question':
      return state.questions;
    case '/session/status':
      return state.statuses;
    case '/experimental/session': {
      const roots = query['roots'] === 'true';
      return [...state.sessions.values()]
        .filter((x) => !roots || x['parentID'] === undefined)
        .map((x): Ses => Object.assign(structuredClone(x), { project: state.projectOf(x.directory) }))
        .toSorted((x, y) => updatedOf(y) - updatedOf(x))
        .slice(0, Number(query['limit'] ?? 500));
    }
    default:
      return undefined;
  }
}

/** Réponses aux permissions et questions, connexion des MCP. */
function handleRequests(method: string, p: string, b: Json, res: http.ServerResponse): boolean {
  if (method !== 'POST') return false;
  let m = /^\/permission\/([^/]+)\/reply$/u.exec(p);
  if (m !== null) {
    const id = m[1];
    const perm = state.permissions.find((x) => x['id'] === id);
    if (perm === undefined) notFound(res, 'permission');
    else {
      state.permissions = state.permissions.filter((x) => x !== perm);
      emit('permission.replied', { sessionID: perm['sessionID'], requestID: id, reply: b['reply'] });
      finishTool(perm, b['reply'] === 'reject' ? null : 'sortie simulée');
      send(res, 200, true);
    }
    return true;
  }
  m = /^\/question\/([^/]+)\/(reply|reject)$/u.exec(p);
  if (m !== null) {
    const [, id, verb] = m;
    const q = state.questions.find((x) => x['id'] === id);
    if (q === undefined) notFound(res, 'question');
    else {
      state.questions = state.questions.filter((x) => x !== q);
      emit(verb === 'reply' ? 'question.replied' : 'question.rejected', { sessionID: q['sessionID'], requestID: id });
      // appel de l'outil `question` : terminé avec les réponses (ou en erreur s'il est ignoré)
      finishQuestion(q, verb === 'reply' ? b['answers'] : null);
      send(res, 200, true);
    }
    return true;
  }
  m = /^\/mcp\/([^/]+)\/(connect|disconnect)$/u.exec(p);
  if (m !== null) {
    state.mcp[decodeURIComponent(m[1] ?? '')] = { status: m[2] === 'connect' ? 'connected' : 'disabled' };
    send(res, 200, true);
    return true;
  }
  return false;
}

/** Actions sur une session existante. */
function handleSession(method: string, ses: Ses, action: string | undefined, query: Record<string, string>, b: Json, res: http.ServerResponse): void {
  const sid = ses.id;
  const msgs = state.messages.get(sid) ?? [];
  const route = `${method} ${action ?? ''}`;
  switch (route) {
    case 'GET ':
      send(res, 200, ses);
      return;
    case 'PATCH ':
      if (typeof b['title'] === 'string') ses.title = b['title'];
      touch(ses);
      send(res, 200, ses);
      return;
    case 'DELETE ':
      state.sessions.delete(sid);
      state.messages.delete(sid);
      emit('session.deleted', { sessionID: sid, info: ses });
      send(res, 200, true);
      return;
    case 'GET message': {
      // du plus récent au plus ancien, par pages ; curseur = index (exclu) dans la liste
      const limit = Number(query['limit'] ?? msgs.length);
      const before = query['before'];
      const end = before === undefined ? msgs.length : Number(Buffer.from(before, 'base64url').toString('utf8'));
      const start = Math.max(0, end - limit);
      send(res, 200, msgs.slice(start, end), start > 0 ? { 'X-Next-Cursor': Buffer.from(String(start)).toString('base64url') } : {});
      return;
    }
    case 'GET todo':
      send(res, 200, state.todos[sid] ?? []);
      return;
    case 'GET children':
      send(res, 200, [...state.sessions.values()].filter((x) => x['parentID'] === sid));
      return;
    case 'POST prompt_async':
    case 'POST message':
      simulateTurn(ses, textOf(b), b);
      send(res, 204);
      return;
    case 'POST command':
      simulateTurn(ses, `/${str(b['command'])} ${str(b['arguments'])}`.trim(), b);
      send(res, 200, {});
      return;
    case 'POST abort':
      setIdle(sid);
      send(res, 200, true);
      return;
    case 'POST fork': {
      const until = typeof b['messageID'] === 'string' ? msgs.findIndex((x) => x.info.id === b['messageID']) : -1;
      const kept = until === -1 ? msgs : msgs.slice(0, until);
      const n = [...state.sessions.values()].filter((x) => x.title.startsWith(`${ses.title} (fork #`)).length + 1;
      const id = state.id('ses');
      const copy: Ses = { ...structuredClone(ses), id, title: `${ses.title} (fork #${n})`, time: { created: Date.now(), updated: Date.now() } };
      // comme opencode : la copie n'a ni agent ni modèle
      delete copy['model'];
      delete copy['agent'];
      state.sessions.set(id, copy);
      state.messages.set(
        id,
        kept.map((x) => ({ info: { ...structuredClone(x.info), sessionID: id }, parts: x.parts.map((pt) => ({ ...structuredClone(pt), sessionID: id })) })),
      );
      emit('session.created', { info: copy });
      send(res, 200, copy);
      return;
    }
    case 'POST revert':
      ses['revert'] = { messageID: b['messageID'] };
      touch(ses);
      send(res, 200, ses);
      return;
    case 'POST unrevert':
      delete ses['revert'];
      touch(ses);
      send(res, 200, ses);
      return;
    case 'POST share':
    case 'DELETE share':
      send(res, 200, { ...ses, share: method === 'DELETE' ? null : { url: `https://example.invalid/s/${sid}` } });
      return;
    case 'POST summarize':
      send(res, 200, true);
      return;
    default:
      notFound(res, `route ${route}`);
  }
}

function openStream(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ directory: null, payload: { type: 'server.connected', properties: {} } })}\n\n`);
  streams.add(res);
  const beat = setInterval(() => {
    res.write(`data: ${JSON.stringify({ directory: null, payload: { type: 'server.heartbeat', properties: {} } })}\n\n`);
  }, 5000);
  req.on('close', () => {
    clearInterval(beat);
    streams.delete(res);
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const query = Object.fromEntries(url.searchParams);
  const method = req.method ?? 'GET';
  const body = method === 'GET' ? undefined : await readBody(req);
  const p = url.pathname;
  const b = obj(body);
  if (p === '/global/event') {
    openStream(req, res);
    return;
  }
  if (p.startsWith('/__test')) {
    if (!handleTest(p, b, res)) notFound(res, p);
    return;
  }
  requests.push({ method, path: p, query, body });
  if (state.failOnce.delete(`${method} ${p}`)) {
    send(res, 500, { name: 'FakeError', data: { message: 'échec simulé' } });
    return;
  }
  if (method === 'GET') {
    const value = simpleRoute(p, query);
    if (value !== undefined) {
      send(res, 200, value);
      return;
    }
  }
  if (handleRequests(method, p, b, res)) return;
  if (p === '/session' && method === 'POST') {
    const directory = query['directory'] ?? '/';
    const id = state.id('ses');
    const ses: Ses = { id, projectID: str(state.projectOf(directory)?.['id'], 'global'), directory, title: str(b['title'], `New session - ${new Date().toISOString()}`), time: { created: Date.now(), updated: Date.now() } };
    state.sessions.set(id, ses);
    state.messages.set(id, []);
    emit('session.created', { info: ses });
    send(res, 200, ses);
    return;
  }
  const m = /^\/session\/([^/]+)(?:\/([a-z_]+))?$/u.exec(p);
  const ses = m === null ? undefined : state.sessions.get(decodeURIComponent(m[1] ?? ''));
  if (m === null || ses === undefined) {
    notFound(res, `${method} ${p}`);
    return;
  }
  handleSession(method, ses, m[2], query, b, res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e: unknown) => {
    send(res, 500, { name: 'FakeError', data: { message: String(e) } });
  });
});
server.listen(Number(args.values.port), '127.0.0.1', () => {
  console.log(`faux opencode : http://127.0.0.1:${args.values.port}`);
});
