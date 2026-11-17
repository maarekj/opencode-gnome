// Faux serveur OpenCode 2 pour les tests de bout en bout (#175) : imite les routes `/api/…` et le
// flux d'événements (`/api/event`) utilisés par l'application, à partir d'un scénario JSON au
// format v2 (projets, sessions, entrées d'historique, permissions, formulaires…). Aucun modèle
// n'est appelé : un prompt reçoit une réponse simulée (« Réponse simulée : … »), en direct
// (étape, bloc de texte par morceaux, fin d'exécution).
//
// Usage : node scripts/fake-opencode.ts [--port 4790] [--scenario fichier.json]
// Pilotage par le test (préfixe /__test) :
//   GET  /__test/requests          requêtes reçues (méthode, chemin, requête, corps), dans l'ordre
//   POST /__test/emit              émet un événement v2 : { type, data, location? }
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
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

const Entity = z.looseObject({ id: z.string() });
const Entry = z.looseObject({ id: z.string(), type: z.string(), time: z.looseObject({ created: z.number() }) });
type Entry = z.output<typeof Entry>;

/** Scénario : état initial du faux serveur (format OpenCode 2). */
const Scenario = z.object({
  /** projets : `{ id, canonical, name?, vcs?, time }` */
  projects: z.optional(z.array(z.looseObject({ id: z.string(), canonical: z.string() }))),
  /** sessions (racines et sous-agents) : `{ id, projectID, location: { directory }, title, … }` */
  sessions: z.optional(z.array(z.looseObject({ id: z.string(), location: z.looseObject({ directory: z.string() }), title: z.string() }))),
  /** entrées d'historique par session (user, assistant, idle…), de la plus ancienne à la plus récente */
  messages: z.optional(z.record(z.string(), z.array(Entry))),
  /** sessions en cours d'exécution */
  active: z.optional(z.array(z.string())),
  permissions: z.optional(z.array(Entity)),
  forms: z.optional(z.array(Entity)),
  /** commandes shell en cours (#182) : `{ id, status, command, cwd, metadata: { sessionID }, time: { started }, output? }` */
  shells: z.optional(z.array(Entity)),
  /** `[{ name, status: { status, error? } }]` */
  mcp: z.optional(z.array(z.looseObject({ name: z.string() }))),
  /** configuration du projet et globale : écrites dans les fichiers opencode.json par le test (pas servies) */
  config: z.optional(z.looseObject({})),
  globalConfig: z.optional(z.looseObject({})),
  agents: z.optional(z.array(z.looseObject({ id: z.string() }))),
  models: z.optional(z.array(z.looseObject({ id: z.string() }))),
  defaultModel: z.optional(z.object({ providerID: z.string(), modelID: z.string() })),
  commands: z.optional(z.array(z.looseObject({ name: z.string() }))),
  skills: z.optional(z.array(z.looseObject({ id: z.string() }))),
  plugins: z.optional(z.array(z.looseObject({}))),
  /** fichiers modifiés de l'arbre de travail : `{ file, status, additions, deletions, patch }` */
  vcsDiff: z.optional(z.array(z.looseObject({ file: z.string() }))),
  /** fichiers du projet pour la complétion `@` : `{ path, type: 'file' | 'directory' }` */
  files: z.optional(z.array(z.looseObject({ path: z.string(), type: z.string() }))),
  /** listes de tâches (non servies en v2, gardées pour mémoire) */
  todos: z.optional(z.record(z.string(), z.array(z.looseObject({})))),
  /** requêtes qui échouent une fois (HTTP 500), ex. `POST /api/session/ses_a/prompt` */
  failOnce: z.optional(z.array(z.string())),
  /** réponse simulée envoyée après un prompt (`false` : aucune) */
  reply: z.optional(z.union([z.string(), z.literal(false)])),
});
type Scenario = z.output<typeof Scenario>;
type Ses = Json & { id: string; location: { directory: string }; title: string };

const DEFAULT_SCENARIO: Scenario = { projects: [{ id: 'prj_demo', canonical: '/tmp/opencode-fake/demo', name: 'demo', vcs: 'git', time: { created: 1, updated: 2 } }] };

const DEFAULT_AGENTS = [
  { id: 'build', name: 'build', mode: 'primary', hidden: false, description: 'Agent par défaut' },
  { id: 'plan', name: 'plan', mode: 'primary', hidden: false, description: 'Planification' },
  { id: 'general', name: 'general', mode: 'subagent', hidden: false, description: 'Sous-agent' },
];
const model = (providerID: string, id: string, name: string, variants: string[]): Json => ({ id, modelID: id, providerID, name, variants: variants.map((v) => ({ id: v })), enabled: true, limit: { context: 200_000, output: 32_000 } });
const DEFAULT_MODELS = [model('fake', 'fake-model', 'Modèle simulé', ['low', 'high'])];
const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

// ---------------------------------------------------------------- état

/** Champs de date (ms depuis 1970) des scénarios. */
const TIME_KEYS = new Set(['created', 'updated', 'completed', 'start', 'end', 'archived', 'ran', 'streamed']);
/** En deçà : pas une date (ordres relatifs comme `created: 1`, laissés tels quels). */
const EPOCH_MIN = 1_000_000_000_000;

function eachDate(v: unknown, fn: (n: number) => number): unknown {
  if (Array.isArray(v)) return v.map((x) => eachDate(x, fn));
  if (typeof v !== 'object' || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = TIME_KEYS.has(k) && typeof x === 'number' && x >= EPOCH_MIN ? fn(x) : eachDate(x, fn);
  return out;
}

/**
 * Décale toutes les dates du scénario d'un même écart : la plus récente devient `now` moins une
 * minute (les écarts entre dates, donc l'ordre et les durées affichées, sont conservés).
 */
export function shiftDates(scenario: Scenario, now: number): Scenario {
  let max = 0;
  eachDate(scenario, (n) => {
    max = Math.max(max, n);
    return n;
  });
  if (max === 0) return scenario;
  const delta = now - 60_000 - max;
  return z.parse(Scenario, eachDate(scenario, (n) => n + delta));
}

class State {
  scenario: Scenario = {};
  readonly sessions = new Map<string, Ses>();
  readonly messages = new Map<string, Entry[]>();
  permissions: Json[] = [];
  forms: Json[] = [];
  shells: Json[] = [];
  active = new Set<string>();
  mcp: Json[] = [];
  failOnce = new Set<string>();
  #seq = 0;

  load(scenario: Scenario): void {
    // dates du scénario recalées sur l'heure de lancement (#135)
    const s = shiftDates(scenario, Date.now());
    this.scenario = s;
    this.sessions.clear();
    this.messages.clear();
    for (const ses of s.sessions ?? []) this.sessions.set(ses.id, { cost: 0, tokens: ZERO_TOKENS, projectID: 'global', time: { created: Date.now(), updated: Date.now() }, ...structuredClone(ses) });
    for (const [id, msgs] of Object.entries(s.messages ?? {})) this.messages.set(id, structuredClone(msgs));
    this.permissions = structuredClone(s.permissions ?? []);
    this.forms = structuredClone(s.forms ?? []);
    this.shells = structuredClone(s.shells ?? []);
    this.active = new Set(s.active ?? []);
    this.mcp = structuredClone(s.mcp ?? []);
    this.failOnce = new Set(s.failOnce ?? []);
  }

  /** Identifiant croissant (« z » : après les identifiants des scénarios `msg_001`…). */
  id(prefix: string): string {
    this.#seq += 1;
    return `${prefix}_z${Date.now().toString(36).padStart(10, '0')}${this.#seq.toString(36).padStart(4, '0')}`;
  }

  projectOf(directory: string): Json | undefined {
    return (this.scenario.projects ?? []).find((p) => directory === p.canonical || directory.startsWith(`${p.canonical}/`));
  }
}

// ---------------------------------------------------------------- serveur

const args = parseArgs({ options: { port: { type: 'string', default: '4790' }, scenario: { type: 'string' } } });
const state = new State();
state.load(args.values.scenario === undefined ? DEFAULT_SCENARIO : z.parse(Scenario, JSON.parse(fs.readFileSync(path.resolve(args.values.scenario), 'utf8'))));
const requests: { method: string; path: string; query: Record<string, string>; body: unknown }[] = [];
const streams = new Set<http.ServerResponse>();
let eventSeq = 0;

/** Événement v2 : `{ id, created, type, location?, data }`. */
function emit(type: string, data: unknown, directory: string | null = null): void {
  eventSeq += 1;
  const event = { id: `evt_${eventSeq}`, created: Date.now(), type, ...(directory === null ? {} : { location: { directory } }), data };
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of streams) res.write(line);
}

function send(res: http.ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

/** Réponse `{ data }` (enveloppe v2), avec la location demandée. */
const data = (res: http.ServerResponse, value: unknown, directory?: string): void => {
  send(res, 200, { ...(directory === undefined ? {} : { location: { directory } }), data: value });
};

const notFound = (res: http.ServerResponse, what: string): void => {
  send(res, 404, { _tag: 'NotFoundError', message: `${what} introuvable` });
};

const dirOf = (ses: Ses): string => ses.location.directory;

function touch(ses: Ses): void {
  ses['time'] = { ...obj(ses['time']), updated: Date.now() };
}

/** Fin d'exécution : entrée « idle », événement de fin. */
function finishExecution(ses: Ses, outcome: 'succeeded' | 'interrupted'): void {
  if (!state.active.delete(ses.id)) return;
  (state.messages.get(ses.id) ?? []).push({ id: state.id('msg'), type: 'idle', time: { created: Date.now() }, outcome });
  emit(outcome === 'succeeded' ? 'session.execution.succeeded' : 'session.execution.interrupted', { sessionID: ses.id, ...(outcome === 'interrupted' ? { reason: 'user' } : {}) });
  touch(ses);
}

/** Réponse simulée à un prompt : message utilisateur, étape de l'agent en direct, fin d'exécution. */
function simulateTurn(ses: Ses, text: string, files: unknown[] = []): string {
  const msgs = state.messages.get(ses.id) ?? [];
  state.messages.set(ses.id, msgs);
  const userID = state.id('msg');
  const now = Date.now();
  // pièces jointes (#183) : comme OpenCode 2, dans l'historique et dans l'événement
  const attached = files.length === 0 ? {} : { files };
  msgs.push({ id: userID, type: 'user', time: { created: now }, text, ...attached });
  emit('session.inbox.enqueued', { sessionID: ses.id, inboxID: userID, item: { type: 'user', payload: { text, ...attached }, delivery: 'steer' } }, dirOf(ses));
  const reply = state.scenario.reply;
  state.active.add(ses.id);
  emit('session.execution.started', { sessionID: ses.id });
  emit('session.inbox.delivered', { sessionID: ses.id, inboxID: userID }, dirOf(ses));
  touch(ses);
  if (reply === false) return userID;
  const agent = str(ses['agent'], 'build');
  const m = obj(ses['model']);
  const ref = { id: str(m['id'], 'fake-model'), providerID: str(m['providerID'], 'fake') };
  setTimeout(() => {
    const id = state.id('msg');
    const answer = reply ?? `Réponse simulée : ${text}`;
    const tokens = { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } };
    emit('session.step.started', { sessionID: ses.id, agent, model: ref, assistantMessageID: id, started: Date.now() });
    emit('session.text.started', { sessionID: ses.id, assistantMessageID: id, ordinal: 0 });
    // deux morceaux : l'application assemble les deltas
    const cut = Math.floor(answer.length / 2);
    emit('session.text.delta', { sessionID: ses.id, assistantMessageID: id, ordinal: 0, delta: answer.slice(0, cut) });
    emit('session.text.delta', { sessionID: ses.id, assistantMessageID: id, ordinal: 0, delta: answer.slice(cut) });
    emit('session.text.ended', { sessionID: ses.id, assistantMessageID: id, ordinal: 0, text: answer });
    emit('session.step.ended', { sessionID: ses.id, assistantMessageID: id, finish: 'stop', tokens, cost: 0 });
    msgs.push({ id, type: 'assistant', time: { created: Date.now(), completed: Date.now() + 1 }, agent, model: ref, content: [{ type: 'text', text: answer }], tokens, cost: 0, finish: 'stop' });
    finishExecution(ses, 'succeeded');
  }, 300);
  return userID;
}

/** Appel d'outil lié à une demande : terminé (sortie simulée) ou en erreur (refus). */
function finishTool(sid: string, source: Json, result: { output: string; metadata?: Json } | null): void {
  const msg = (state.messages.get(sid) ?? []).find((x) => x.id === source['messageID']);
  const raw: unknown = msg?.['content'];
  const content: Json[] = Array.isArray(raw) ? raw.filter((x): x is Json => isJson(x)) : [];
  const call = content.find((x) => x['type'] === 'tool' && x['id'] === source['id']);
  if (msg === undefined || call === undefined) return;
  const input = obj(obj(call['state'])['input']);
  call['state'] =
    result === null
      ? { status: 'error', input, error: { type: 'PermissionRejected', message: 'Permission refusée' } }
      : { status: 'completed', input, content: [{ type: 'text', text: result.output }], ...(result.metadata === undefined ? {} : { metadata: result.metadata }) };
  call['time'] = { ...obj(call['time']), completed: Date.now() };
  const base = { sessionID: sid, assistantMessageID: msg.id, id: source['id'], executed: true };
  if (result === null) emit('session.tool.failed', { ...base, error: { type: 'PermissionRejected', message: 'Permission refusée' } });
  else emit('session.tool.success', { ...base, content: [{ type: 'text', text: result.output }], ...(result.metadata === undefined ? {} : { metadata: result.metadata }) });
  const ses = state.sessions.get(sid);
  if (ses !== undefined) finishExecution(ses, 'succeeded');
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
      const location = obj(b['location']);
      emit(str(b['type']), b['data'] ?? {}, typeof location['directory'] === 'string' ? location['directory'] : null);
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

/** Page de sessions : filtres v2 (racines, dossier), plus récentes d'abord, curseur = index. */
function sessionPage(query: Record<string, string>): Json {
  const roots = query['parentID'] === 'null';
  const all = [...state.sessions.values()]
    .filter((x) => !roots || x['parentID'] === undefined)
    .filter((x) => query['directory'] === undefined || dirOf(x) === query['directory'])
    .toSorted((x, y) => updatedOf(y) - updatedOf(x));
  const start = query['cursor'] === undefined ? 0 : Number(Buffer.from(query['cursor'], 'base64url').toString('utf8'));
  const limit = Number(query['limit'] ?? 50);
  const end = start + limit;
  return { data: all.slice(start, end), cursor: { previous: null, next: end < all.length ? Buffer.from(String(end)).toString('base64url') : null } };
}

/** Page d'historique : la plus récente d'abord (`order=desc`), curseur = index (exclu) dans la liste. */
function messagePage(msgs: readonly Entry[], query: Record<string, string>): Json {
  const limit = Number(query['limit'] ?? msgs.length);
  const end = query['cursor'] === undefined ? msgs.length : Number(Buffer.from(query['cursor'], 'base64url').toString('utf8'));
  const start = Math.max(0, end - limit);
  return { data: msgs.slice(start, end).toReversed(), cursor: { previous: null, next: start > 0 ? Buffer.from(String(start)).toString('base64url') : null } };
}

/** Routes en lecture simple ; la valeur renvoyée (déjà enveloppée), ou undefined si inconnue. */
function simpleRoute(p: string, query: Record<string, string>): unknown {
  const s = state.scenario;
  const directory = query['location[directory]'] ?? '/';
  const located = (value: unknown): Json => ({ location: { directory }, data: value });
  switch (p) {
    case '/api/info':
      return { version: 'fake', pid: process.pid, urls: [], paths: { tmp: '/tmp' } };
    case '/api/project':
      return (s.projects ?? []).map((x) => Object.assign({ sandboxes: [], time: { created: 1, updated: 2 } }, x));
    case '/api/session':
      return sessionPage(query);
    case '/api/session/active':
      return { data: Object.fromEntries([...state.active].map((id) => [id, { type: 'running' }])) };
    case '/api/agent':
      return located(s.agents ?? DEFAULT_AGENTS);
    case '/api/model':
      return located(s.models ?? DEFAULT_MODELS);
    case '/api/model/default': {
      const models = s.models ?? DEFAULT_MODELS;
      const d = s.defaultModel;
      return located((d === undefined ? models[0] : models.find((m) => m['providerID'] === d.providerID && m['modelID'] === d.modelID)) ?? null);
    }
    case '/api/command':
      return located(s.commands ?? []);
    case '/api/skill':
      return located(s.skills ?? []);
    case '/api/plugin': {
      // `global: true` : plugin de la configuration globale ; les autres, seulement dans un projet
      const inProject = state.projectOf(directory) !== undefined;
      return located((s.plugins ?? []).filter((x) => inProject || x['global'] === true));
    }
    case '/api/mcp':
      return located(state.mcp);
    case '/api/vcs':
      return located({ branch: { current: 'main' } });
    case '/api/vcs/diff':
      return located(s.vcsDiff ?? []);
    case '/api/fs/find': {
      // comme opencode : correspondance approximative sur le chemin, dossiers avec `type=directory`
      const q = (query['query'] ?? '').toLowerCase();
      const type = query['type'] ?? 'file';
      return located(
        (s.files ?? [])
          .filter((f) => f['type'] === type && f.path.toLowerCase().includes(q))
          .slice(0, Number(query['limit'] ?? 20)),
      );
    }
    case '/api/permission/request':
      return located(state.permissions.filter((x) => directory === '/' || dirOf(state.sessions.get(str(x['sessionID'])) ?? { id: '', title: '', location: { directory } }) === directory));
    case '/api/shell':
      return located(state.shells.map(({ output: _output, ...info }) => info));
    case '/api/form':
      return located(state.forms.filter((x) => directory === '/' || dirOf(state.sessions.get(str(x['sessionID'])) ?? { id: '', title: '', location: { directory } }) === directory));
    default:
      return undefined;
  }
}

/** MCP, rechargement de la configuration ; true si la requête a été traitée. */
function handleGlobal(method: string, p: string, res: http.ServerResponse): boolean {
  if (method !== 'POST') return false;
  const m = /^\/api\/experimental\/mcp\/([^/]+)\/(connect|disconnect)$/u.exec(p);
  if (m !== null) {
    const name = decodeURIComponent(m[1] ?? '');
    const entry = state.mcp.find((x) => x['name'] === name);
    const status = { status: m[2] === 'connect' ? 'connected' : 'disabled' };
    if (entry === undefined) state.mcp.push({ name, status });
    else entry['status'] = status;
    send(res, 200);
    return true;
  }
  if (p === '/api/location/reload') {
    send(res, 200);
    return true;
  }
  return false;
}

/** Actions sur une session existante (`/api/session/:id/<action…>`). */
function handleSession(method: string, ses: Ses, action: string, query: Record<string, string>, b: Json, res: http.ServerResponse): void {
  const sid = ses.id;
  const msgs = state.messages.get(sid) ?? [];
  const route = `${method} ${action}`;
  // demandes : `permission/<id>/reply`, `form/<id>/reply`, `form/<id>`
  const req = /^(permission|form)\/([^/]+)(\/reply)?$/u.exec(action);
  if (req !== null) {
    const [, kind, id, reply] = req;
    if (kind === 'permission' && method === 'POST' && reply !== undefined) {
      const perm = state.permissions.find((x) => x['id'] === id);
      if (perm === undefined) {
        notFound(res, 'permission');
        return;
      }
      state.permissions = state.permissions.filter((x) => x !== perm);
      emit('permission.replied', { sessionID: perm['sessionID'], requestID: id, reply: b['decision'] });
      finishTool(str(perm['sessionID']), obj(perm['source']), b['decision'] === 'reject' ? null : { output: 'sortie simulée' });
      send(res, 200);
      return;
    }
    if (kind === 'form' && ((method === 'POST' && reply !== undefined) || (method === 'DELETE' && reply === undefined))) {
      const form = state.forms.find((x) => x['id'] === id);
      if (form === undefined) {
        notFound(res, 'formulaire');
        return;
      }
      state.forms = state.forms.filter((x) => x !== form);
      const answered = method === 'POST';
      emit(answered ? 'form.replied' : 'form.cancelled', { id, sessionID: form['sessionID'], ...(answered ? { answer: b['answer'] } : {}) });
      // question de l'agent : l'appel de l'outil `question` se termine avec les réponses
      const tool = obj(obj(form['metadata'])['tool']);
      const answers = Object.values(obj(b['answer'])).map((v): string[] => (Array.isArray(v) ? v.map(String) : [String(v)]));
      finishTool(str(form['sessionID']), tool, answered ? { output: 'ok', metadata: { answers } } : null);
      send(res, 200);
      return;
    }
  }
  switch (route) {
    case 'GET ':
      data(res, ses);
      return;
    case 'PATCH ':
      if (typeof b['title'] === 'string') ses.title = b['title'];
      touch(ses);
      emit('session.renamed', { sessionID: sid, title: ses.title });
      send(res, 200);
      return;
    case 'DELETE ':
      state.sessions.delete(sid);
      state.messages.delete(sid);
      emit('session.deleted', { sessionID: sid });
      send(res, 200);
      return;
    case 'GET message':
      send(res, 200, messagePage(msgs, query));
      return;
    case 'POST prompt': {
      // comme OpenCode 2 : les `data:` deviennent des pièces jointes en base64 (#183)
      const files = (Array.isArray(b['files']) ? b['files'] : []).flatMap((f) => {
        const m = /^data:([^;]+);base64,(.*)$/su.exec(str(obj(f)['uri']));
        return m === null ? [] : [{ data: m[2] ?? '', mime: m[1] ?? '', source: { type: 'inline' }, ...(obj(f)['name'] === undefined ? {} : { name: str(obj(f)['name']) }) }];
      });
      const id = simulateTurn(ses, str(b['text']), files);
      data(res, { id, sessionID: sid, type: 'user', payload: { text: str(b['text']) }, delivery: 'steer' });
      return;
    }
    case 'POST command':
      simulateTurn(ses, `/${str(b['name'])} ${str(b['text'])}`.trim());
      send(res, 200);
      return;
    case 'POST agent':
      ses['agent'] = b['agent'];
      send(res, 200);
      return;
    case 'POST model':
      ses['model'] = b['model'];
      send(res, 200);
      return;
    case 'POST interrupt':
      finishExecution(ses, 'interrupted');
      data(res, { interrupted: true });
      return;
    case 'POST compact':
      data(res, { id: state.id('msg'), sessionID: sid, type: 'compaction', delivery: 'steer' });
      return;
    case 'POST fork': {
      const until = typeof b['before'] === 'string' ? msgs.findIndex((x) => x.id === b['before']) : -1;
      const kept = until === -1 ? msgs : msgs.slice(0, until);
      const n = [...state.sessions.values()].filter((x) => x.title.startsWith(`${ses.title} (fork #`)).length + 1;
      const id = state.id('ses');
      const copy: Ses = { ...structuredClone(ses), id, title: `${ses.title} (fork #${n})`, time: { created: Date.now(), updated: Date.now() } };
      state.sessions.set(id, copy);
      state.messages.set(id, structuredClone(kept));
      emit('session.created', { sessionID: id, projectID: copy['projectID'], location: copy.location, slug: id, title: copy.title });
      data(res, copy);
      return;
    }
    case 'POST revert/stage':
      ses['revert'] = { messageID: b['messageID'] };
      touch(ses);
      emit('session.revert.staged', { sessionID: sid, revert: ses['revert'] });
      data(res, ses['revert']);
      return;
    case 'DELETE revert':
      delete ses['revert'];
      touch(ses);
      emit('session.revert.cleared', { sessionID: sid });
      send(res, 200);
      return;
    default:
      notFound(res, `route ${route}`);
  }
}

function openStream(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ id: 'evt_0', type: 'server.connected', data: {} })}\n\n`);
  streams.add(res);
  // battement : ligne de commentaire, comme OpenCode 2
  const beat = setInterval(() => {
    res.write(': heartbeat\n\n');
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
  if (p === '/api/event') {
    openStream(req, res);
    return;
  }
  if (p.startsWith('/__test')) {
    if (!handleTest(p, b, res)) notFound(res, p);
    return;
  }
  requests.push({ method, path: p, query, body });
  if (state.failOnce.delete(`${method} ${p}`)) {
    send(res, 500, { _tag: 'FakeError', message: 'échec simulé' });
    return;
  }
  if (method === 'GET') {
    const value = simpleRoute(p, query);
    if (value !== undefined) {
      send(res, 200, value);
      return;
    }
  }
  if (handleGlobal(method, p, res)) return;
  // commandes shell (#182) : sortie (curseur en caractères), arrêt
  const shell = /^\/api\/shell\/([^/]+)(\/output)?$/u.exec(p);
  if (shell !== null) {
    const id = decodeURIComponent(shell[1] ?? '');
    const sh = state.shells.find((x) => x['id'] === id);
    if (sh === undefined) {
      notFound(res, p);
      return;
    }
    if (method === 'GET' && shell[2] !== undefined) {
      const out = str(sh['output']);
      const cursor = Number(query['cursor'] ?? 0);
      send(res, 200, { location: { directory: str(sh['cwd'], '/') }, data: { output: out.slice(cursor), cursor: out.length, size: out.length, truncated: false } });
      return;
    }
    if (method === 'DELETE') {
      state.shells = state.shells.filter((x) => x !== sh);
      emit('shell.deleted', { id });
      res.writeHead(204).end();
      return;
    }
  }
  if (p === '/api/session' && method === 'POST') {
    const directory = str(obj(b['location'])['directory'], '/');
    const id = state.id('ses');
    const ses: Ses = {
      id,
      projectID: str(state.projectOf(directory)?.['id'], 'global'),
      location: { directory },
      title: str(b['title'], `New session - ${new Date().toISOString()}`),
      cost: 0,
      tokens: ZERO_TOKENS,
      time: { created: Date.now(), updated: Date.now() },
      ...(Array.isArray(b['permissions']) ? { permissions: b['permissions'] } : {}),
    };
    state.sessions.set(id, ses);
    state.messages.set(id, []);
    emit('session.created', { sessionID: id, projectID: ses['projectID'], location: ses.location, slug: id, title: ses.title }, directory);
    data(res, ses);
    return;
  }
  const m = /^\/api\/session\/([^/]+)(?:\/(.+))?$/u.exec(p);
  const ses = m === null ? undefined : state.sessions.get(decodeURIComponent(m[1] ?? ''));
  if (m === null || ses === undefined) {
    notFound(res, `${method} ${p}`);
    return;
  }
  handleSession(method, ses, m[2] ?? '', query, b, res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e: unknown) => {
    send(res, 500, { _tag: 'FakeError', message: String(e) });
  });
});
server.listen(Number(args.values.port), '127.0.0.1', () => {
  console.log(`faux opencode (v2) : http://127.0.0.1:${args.values.port}`);
});
