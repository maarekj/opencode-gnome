// Client HTTP + SSE pour `opencode serve`, basé sur libsoup 3 (GJS, sans Node).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import * as z from 'zod/mini';
import { errorMessage, HttpError } from './errors.ts';
import { serverPassword } from './server.ts';
import { type McpConfig, type Agent, AppEvent, type Attachment, type Command, type FileDiff, type Mention, GlobalEnvelope, type McpStatus, MessageWithParts, type Skill, type OpencodeConfig, type Providers, VcsInfo, type Project, type Session, type SessionStatus, Todo, type AppEventEnvelope } from './schemas.ts';
import { OpencodeV2 } from './v2/client.ts';
import { declaredMcp } from './v2/config.ts';
import { appProject, appSession, type FormAnswer, type FormV2, type PermissionV2 } from './v2/schemas.ts';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Soup.Session.prototype, 'send_async', 'send_finish');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish');

type Query = Readonly<Record<string, string | number | boolean | undefined>>;

const decoder = new TextDecoder();

/** Page d'historique v2 sans validation des entrées. */
const RawPage = z.object({ data: z.array(z.unknown()), cursor: z.object({ next: z.optional(z.nullable(z.string())) }) });

/** Taille des morceaux décodés entre deux tours de boucle principale. */
const DECODE_CHUNK = 2 * 1024 * 1024;

/**
 * UTF-8 → texte. Une grosse réponse (sorties d'outils : des dizaines de Mo) est décodée par
 * morceaux, en rendant la main à la boucle principale entre deux : le décodage d'un bloc de
 * 64 Mo la figeait ~400 ms (#159).
 */
export async function decodeLarge(data: Uint8Array, chunk = DECODE_CHUNK): Promise<string> {
  if (data.length <= chunk) return decoder.decode(data);
  const parts: string[] = [];
  // Le TextDecoder de GJS ignore l'option `stream` (erreur, #163) : chaque morceau est coupé
  // sur une frontière de caractère et décodé seul.
  for (let i = 0; i < data.length; ) {
    const end = utf8Boundary(data, i + chunk);
    parts.push(decoder.decode(data.subarray(i, end)));
    i = end;
    // oxlint-disable-next-line no-await-in-loop -- pause volontaire entre deux morceaux
    await new Promise<void>((resolve) => {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
      });
    });
  }
  return parts.join('');
}

/**
 * Position ≤ `end` qui ne coupe pas un caractère UTF-8 : recule tant que l'octet est une
 * continuation (10xxxxxx). Au plus 3 octets de recul pour un texte valide.
 */
export function utf8Boundary(data: Uint8Array, end: number): number {
  if (end >= data.length) return data.length;
  let i = end;
  while (i > end - 3 && ((data[i] ?? 0) & 0xc0) === 0x80) i--;
  return i;
}
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

/** Délai sans aucune donnée du flux d'événements avant reconnexion (heartbeat : 10 s). */
const WATCHDOG_MS = 30_000;

/** Chemin local d'une URI `file://` (hôte, `%` mal formé : URI laissée telle quelle, #97). */
const filePath = (uri: string): string => {
  try {
    return GLib.filename_from_uri(uri)[0];
  } catch {
    return uri;
  }
};

/** Durée de vie du cache des agents, modèles et commandes (ms). */
const CACHE_MS = 60_000;

export class OpencodeClient {
  readonly url: string;
  // libsoup limite les connexions par hôte (2 par défaut) : relevé, et le flux SSE (connexion
  // permanente) a sa propre session pour ne jamais attendre derrière une requête longue (#62)
  readonly #session = new Soup.Session({ timeout: 30, maxConnsPerHost: 8, maxConns: 32 });
  /** Requêtes longues (commandes, résumé…) : pas de timeout. */
  readonly #long = new Soup.Session({ timeout: 0, idleTimeout: 0, maxConnsPerHost: 8, maxConns: 32 });
  /** Flux SSE uniquement. */
  readonly #events = new Soup.Session({ timeout: 0, idleTimeout: 0 });

  /** mot de passe HTTP Basic du serveur (accès réseau protégé), ou vide */
  #auth = '';
  /** réponses partagées par les pages d'un même dossier (agents, modèles, commandes : #158) */
  readonly #cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(url: string, password = serverPassword()) {
    this.url = url.replace(/\/+$/u, '');
    this.setPassword(password);
  }

  /** Change le mot de passe envoyé (réglage modifié dans la fenêtre « Serveur opencode »). */
  setPassword(password: string): void {
    this.#auth = password === '' ? '' : `Basic ${GLib.base64_encode(encoder.encode(`opencode:${password}`))}`;
  }

  /** En-tête d'authentification sur chaque requête. */
  #authorize(msg: Soup.Message): void {
    if (this.#auth !== '') msg.get_request_headers().replace('Authorization', this.#auth);
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
    opts: { query?: Query; body?: unknown; long?: boolean; cancellable?: Gio.Cancellable; headers?: (h: Soup.MessageHeaders) => void } = {},
  ): Promise<z.output<S>> {
    const msg = Soup.Message.new(method, this.#uri(path, opts.query));
    if (msg === null) throw new Error(`URL invalide : ${this.url}${path}`);
    this.#authorize(msg);
    if (opts.body !== undefined) {
      msg.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(JSON.stringify(opts.body))));
    }
    const session = opts.long === true ? this.#long : this.#session;
    const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, opts.cancellable ?? null);
    const data = bytes.get_data();
    const text = data === null ? '' : await decodeLarge(data);
    const status: number = msg.get_status();
    if (status < 200 || status >= 300) throw new HttpError(status, `${method} ${path} : HTTP ${status} ${text.slice(0, 200)}`);
    opts.headers?.(msg.get_response_headers());
    return z.parse(schema, text === '' ? null : JSON.parse(text));
  }

  get<S extends z.ZodMiniType>(path: string, schema: S, query?: Query): Promise<z.output<S>> {
    return this.request('GET', path, schema, query === undefined ? {} : { query });
  }

  // ------------------------------------------------------------------ API

  /** API d'OpenCode 2 (#169) sur le même transport. */
  get v2(): OpencodeV2 {
    this.#v2 ??= new OpencodeV2(this);
    return this.#v2;
  }
  #v2: OpencodeV2 | null = null;

  /** Version du serveur. */
  async health(): Promise<{ version: string }> {
    return { version: (await this.v2.info()).version };
  }

  async projects(): Promise<Project[]> {
    return (await this.v2.projects()).map((p) => appProject(p));
  }

  /** Sessions racines (sans les sous-agents) de tous les projets, les plus récentes d'abord. */
  async sessions(limit = 500): Promise<Session[]> {
    const out: Session[] = [];
    let cursor: string | undefined;
    // pages de 200 au plus ; une page vide termine (le serveur peut annoncer une suite vide)
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- pages successives (curseur)
      const page = await this.v2.sessions({ roots: true, limit: Math.min(200, limit - out.length), ...(cursor === undefined ? {} : { cursor }) });
      out.push(...page.items.map((x) => appSession(x)));
      if (page.next === null || page.items.length === 0 || out.length >= limit) return out;
      cursor = page.next;
    }
  }

  /** Sessions en cours d'exécution (les sessions absentes sont au repos), tous dossiers. */
  async statuses(): Promise<Record<string, SessionStatus>> {
    const active = await this.v2.active();
    return Object.fromEntries(Object.keys(active).map((id) => [id, { type: 'busy' }]));
  }

  /** Derniers messages d'une session (ordre chronologique). */
  messages(sessionID: string, limit = 200): Promise<MessageWithParts[]> {
    return this.get(`/session/${encodeURIComponent(sessionID)}/message`, z.array(MessageWithParts), { limit });
  }

  /**
   * Page de messages, la plus récente d'abord en partant de `before` (curseur de la page
   * précédente). `older` : curseur de la page suivante (plus ancienne), null au début de la session.
   */
  async messagePage(sessionID: string, limit: number, before?: string): Promise<{ messages: MessageWithParts[]; older: string | null }> {
    let older: string | null = null;
    const messages = await this.request('GET', `/session/${encodeURIComponent(sessionID)}/message`, z.array(MessageWithParts), {
      query: { limit, before },
      headers: (h) => {
        older = h.get_one('X-Next-Cursor');
      },
    });
    return { messages, older };
  }

  /**
   * Page d'entrées de l'historique non validée (indexation de la recherche : seuls les textes
   * sont lus, la validation des sorties d'outils serait coûteuse : #159), dans l'ordre
   * chronologique ; `older` : curseur de la page plus ancienne, null au début de la session.
   */
  async messagePageRaw(sessionID: string, limit: number, before?: string): Promise<{ messages: unknown[]; older: string | null }> {
    const r = await this.request('GET', `/api/session/${encodeURIComponent(sessionID)}/message`, RawPage, { query: before === undefined ? { limit, order: 'desc' } : { limit, cursor: before } });
    return { messages: r.data.toReversed(), older: r.data.length === 0 ? null : (r.cursor.next ?? null) };
  }

  /** Liste de tâches de la session (outil `todowrite`). */
  todos(sessionID: string, directory: string): Promise<Todo[]> {
    return this.get(`/session/${encodeURIComponent(sessionID)}/todo`, z.array(Todo), { directory });
  }

  async session(sessionID: string): Promise<Session> {
    return appSession(await this.v2.session(sessionID));
  }

  /** Nouvelle session ; `allowAll` : aucune demande de permission (tâches planifiées). */
  async createSession(directory: string, opts: { title?: string; allowAll?: boolean } = {}): Promise<Session> {
    return appSession(await this.v2.createSession({ location: { directory }, ...(opts.title === undefined ? {} : { title: opts.title }), ...(opts.allowAll === true ? { permissions: [{ action: '*', resource: '*', effect: 'allow' }] } : {}) }));
  }

  async renameSession(sessionID: string, _directory: string, title: string): Promise<Session> {
    await this.v2.updateSession({ sessionID, title });
    return this.session(sessionID);
  }

  /** Copie une session (entière, ou jusqu'à `messageID` exclu) dans une nouvelle session. */
  async forkSession(sessionID: string, _directory: string, messageID?: string): Promise<Session> {
    return appSession(await this.v2.forkSession({ sessionID, ...(messageID === undefined ? {} : { before: messageID }) }));
  }

  async deleteSession(sessionID: string, _directory: string): Promise<void> {
    await this.v2.removeSession({ sessionID });
  }

  /**
   * Agent et modèle de la session (v2 : réglés sur la session, plus dans chaque message), s'ils
   * sont donnés.
   */
  async #choose(sessionID: string, opts: PromptOptions): Promise<void> {
    if (opts.agent === undefined && opts.model === undefined) return;
    // seulement s'ils changent : chaque changement s'inscrit dans l'historique de la session
    const current = await this.v2.session(sessionID);
    if (opts.agent !== undefined && opts.agent !== current.agent) await this.v2.switchAgent({ sessionID, agent: opts.agent });
    const m = opts.model;
    if (m !== undefined && (m.modelID !== current.model?.id || m.providerID !== current.model.providerID || (opts.variant ?? undefined) !== current.model.variant)) {
      await this.v2.switchModel({ sessionID, model: { id: m.modelID, providerID: m.providerID, ...(opts.variant === undefined ? {} : { variant: opts.variant }) } });
    }
  }

  /** Pièces jointes et mentions `@chemin` → fichiers d'un message v2. */
  #files(directory: string, files: readonly Attachment[], mentions: readonly Mention[]): { uri: string; name?: string; mention?: { start: number; end: number; text: string } }[] {
    return [
      ...files.map((f) => ({ uri: f.url, name: f.filename })),
      ...mentions.map((m) => ({ uri: GLib.filename_to_uri(GLib.build_filenamev([directory, m.path]), null), name: m.path, mention: { start: m.start, end: m.end, text: `@${m.path}` } })),
    ];
  }

  /** Envoie un prompt sans attendre la réponse (elle arrive par le flux d'événements). */
  async prompt(sessionID: string, directory: string, text: string, opts: PromptOptions = {}): Promise<void> {
    const { files = [], mentions = [] } = opts;
    // Les fournisseurs refusent les types non pris en charge (xlsx, zip…), et l'erreur se répète
    // à chaque tour car la pièce jointe reste dans l'historique : ces fichiers sont transmis par
    // leur chemin, l'agent les ouvre avec ses outils.
    const direct = files.filter((f) => isModelReadable(f.mime) || !f.url.startsWith('file://'));
    const byPath = files.filter((f) => !direct.includes(f));
    const paths = byPath.map((f) => `- ${filePath(f.url)}`);
    const fullText = paths.length === 0 ? text : `${text}${text === '' ? '' : '\n\n'}Fichiers joints :\n${paths.join('\n')}`;
    await this.#choose(sessionID, opts);
    const all = this.#files(directory, direct, mentions);
    await this.v2.prompt({ sessionID, text: fullText, ...(all.length === 0 ? {} : { files: all }) });
  }

  /** Commandes disponibles dans le répertoire (serveur, utilisateur, projet, skills, MCP). */
  async commands(directory: string): Promise<Command[]> {
    return (await this.v2.commands(directory)).map((c): Command => (c.description === undefined ? { name: c.name } : { name: c.name, description: c.description }));
  }

  /** Exécute une commande comme la TUI ; la progression arrive par le flux d'événements. */
  async command(sessionID: string, directory: string, command: string, args: string, opts: PromptOptions = {}): Promise<void> {
    const { files = [], mentions = [] } = opts;
    await this.#choose(sessionID, opts);
    const all = this.#files(directory, files, mentions);
    await this.v2.command({ sessionID, name: command, text: args, ...(all.length === 0 ? {} : { files: all }) });
  }

  /** Compacte la session, comme `/compact` (modèle de la session). */
  async summarize(sessionID: string, _directory: string, _model: { providerID: string; modelID: string }): Promise<void> {
    await this.v2.compact({ sessionID });
  }

  /** Annule les messages à partir de `messageID` (et les modifications de fichiers associées). */
  async revert(sessionID: string, _directory: string, messageID: string): Promise<void> {
    await this.v2.revertStage({ sessionID, messageID, files: true });
  }

  /** Rétablit tous les messages annulés. */
  async unrevert(sessionID: string, _directory: string): Promise<void> {
    await this.v2.revertClear(sessionID);
  }

  /** Partage : retiré d'OpenCode 2. */
  share(_sessionID: string, _directory: string): Promise<string | null> {
    return Promise.reject(new Error('le partage de session n’existe plus dans OpenCode 2'));
  }

  unshare(_sessionID: string, _directory: string): Promise<void> {
    return Promise.reject(new Error('le partage de session n’existe plus dans OpenCode 2'));
  }

  /** Recherche floue de fichiers (ou dossiers) du répertoire, triée par pertinence, `.gitignore` respecté. */
  async findFiles(directory: string, query: string, opts: { type?: 'file' | 'directory'; limit?: number; cancellable?: Gio.Cancellable } = {}): Promise<string[]> {
    const { cancellable, ...rest } = opts;
    const found = await this.v2.findFiles(directory, { query, ...rest }, cancellable);
    // dossiers : chemin terminé par « / » (comme la v1) ; racine exclue
    return found.filter((e) => e.path !== '/' && e.path !== '').map((e) => (e.type === 'directory' && !e.path.endsWith('/') ? `${e.path}/` : e.path));
  }

  async abort(sessionID: string, _directory: string): Promise<void> {
    await this.v2.interrupt({ sessionID });
  }

  /** Permissions en attente dans un dossier. */
  permissions(directory: string): Promise<PermissionV2[]> {
    return this.v2.permissions(directory);
  }

  async replyPermission(sessionID: string, requestID: string, reply: 'once' | 'always' | 'reject'): Promise<void> {
    await this.v2.replyPermission({ sessionID, requestID, decision: reply });
  }

  /** Formulaires (questions de l'agent) en attente dans un dossier. */
  questions(directory: string): Promise<FormV2[]> {
    return this.v2.forms(directory);
  }

  async replyQuestion(sessionID: string, formID: string, answer: FormAnswer): Promise<void> {
    await this.v2.replyForm({ sessionID, formID, answer });
  }

  async rejectQuestion(sessionID: string, formID: string): Promise<void> {
    await this.v2.cancelForm({ sessionID, formID });
  }

  async agents(directory: string): Promise<Agent[]> {
    return (await this.v2.agents(directory)).map((a): Agent => {
      const agent: Agent = { name: a.id, mode: a.mode, hidden: a.hidden };
      if (a.description !== undefined) agent.description = a.description;
      if (a.model?.variant !== undefined) agent.variant = a.model.variant;
      return agent;
    });
  }

  /** État des serveurs MCP du répertoire (projet ou global). */
  async mcpStatus(directory: string): Promise<Record<string, McpStatus>> {
    return Object.fromEntries((await this.v2.mcp(directory)).map((m) => [m.name, 'error' in m.status ? { status: m.status.status, error: m.status.error } : { status: m.status.status }]));
  }

  /** Serveurs MCP déclarés dans les fichiers de configuration (`null` : configuration globale). */
  mcpConfig(directory: string | null): Promise<Record<string, McpConfig>> {
    return Promise.resolve(declaredMcp(directory));
  }

  /**
   * Plugins chargés par le serveur pour le dossier (`null` : dossier personnel), au format des
   * déclarations : `nom@version`, `file://chemin` ; intégrés exclus.
   */
  async plugins(directory: string | null): Promise<unknown[]> {
    const list = await this.v2.plugins(directory ?? GLib.get_home_dir());
    return list.flatMap((p) => {
      const src = p.source;
      if (src.type === 'package') return [src.version === undefined ? src.target : `${src.target}@${src.version}`];
      if (src.type === 'local') return [GLib.filename_to_uri(src.path, null)];
      return [];
    });
  }

  async mcpConnect(name: string, directory: string, connect: boolean): Promise<void> {
    await this.v2.mcpConnect(directory, name, connect);
  }

  /** Relit la configuration du répertoire (opencode.json, MCP…) : cache des choix vidé. */
  async disposeInstance(directory: string): Promise<void> {
    for (const k of this.#cache.keys()) if (k.endsWith(`\n${directory}`)) this.#cache.delete(k);
    await this.v2.reload(directory);
  }

  async skills(directory: string): Promise<Skill[]> {
    return (await this.v2.skills(directory)).map((s): Skill => (s.description === undefined ? { name: s.name, location: s.path } : { name: s.name, description: s.description, location: s.path }));
  }

  /**
   * Réponse mise en cache par dossier pendant `CACHE_MS` (même promesse pour les appels
   * simultanés) ; une erreur n'est pas gardée.
   */
  #cached<T>(what: string, directory: string, load: () => Promise<T>): Promise<T> {
    const key = `${what}\n${directory}`;
    const hit = this.#cache.get(key);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- même clé, même type
    if (hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>;
    const value = load();
    this.#cache.set(key, { at: Date.now(), value });
    value.catch(() => {
      if (this.#cache.get(key)?.value === value) this.#cache.delete(key);
    });
    return value;
  }

  /** Agents, modèles et config du dossier, en cache (compositeurs des conversations). */
  cachedChoices(directory: string): Promise<{ agents: Agent[]; providers: Providers; config: OpencodeConfig | null }> {
    return this.#cached('choices', directory, async () => {
      const [agents, providers, config] = await Promise.all([this.agents(directory), this.providers(directory), this.config(directory).catch(() => null)]);
      return { agents, providers, config };
    });
  }

  /** Commandes du dossier, en cache. */
  cachedCommands(directory: string): Promise<Command[]> {
    return this.#cached('commands', directory, () => this.commands(directory));
  }

  /** Modèle par défaut du dossier (`fournisseur/modèle`). */
  async config(directory: string): Promise<OpencodeConfig> {
    const d = await this.v2.defaultModel(directory);
    return { model: d === null ? null : `${d.providerID}/${d.modelID}` };
  }

  /** Modèles activés, regroupés par fournisseur ; défaut : celui du dossier. */
  async providers(directory: string): Promise<Providers> {
    const [models, def] = await Promise.all([this.v2.models(directory), this.v2.defaultModel(directory).catch(() => null)]);
    const byProvider = new Map<string, Providers['providers'][number]>();
    for (const m of models) {
      if (!m.enabled) continue;
      const p = byProvider.get(m.providerID) ?? { id: m.providerID, name: m.providerID, models: {} };
      p.models[m.modelID] = { id: m.modelID, name: m.name, limit: { context: m.limit.context }, variants: Object.fromEntries(m.variants.map((v) => [v.id, {}])) };
      byProvider.set(m.providerID, p);
    }
    return { providers: [...byProvider.values()], default: def === null ? {} : { [def.providerID]: def.modelID } };
  }

  /** Fichiers modifiés de l'arbre de travail git du répertoire (indexés ou non, nouveaux fichiers compris). */
  async gitDiff(directory: string): Promise<FileDiff[]> {
    return (await this.v2.vcsDiff(directory, 'working')).map((d) => ({ file: d.file, status: d.status, additions: d.additions, deletions: d.deletions, patch: d.patch }));
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
  /**
   * `skip` : événement de streaming à ignorer sans l'analyser (JSON + zod), par exemple les
   * messages d'une session qu'aucune conversation ouverte ne suit (#160).
   */
  listen(onEvent: (e: AppEventEnvelope) => void, onState: (connected: boolean, error?: string) => void, skip: ((type: string, sessionID: string) => boolean) | null = null): () => void {
    return this.listenRaw('/global/event', (raw) => dispatch(raw, onEvent, skip), onState);
  }

  /**
   * Flux SSE brut (`path`, ex. `/api/event` d'OpenCode 2) : chaque `data:` complet est passé tel
   * quel à `onData`. Reconnexion et chien de garde comme `listen`.
   */
  listenRaw(path: string, onData: (raw: string) => void, onState: (connected: boolean, error?: string) => void): () => void {
    const cancellable = new Gio.Cancellable();
    let retry = 0;

    // une connexion, puis reconnexion après un délai croissant (1 à 5 s)
    const connect = async (): Promise<void> => {
      try {
        await this.#readStream(cancellable, path, onData, () => {
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

  /**
   * Lit un flux jusqu'à sa fin. Chien de garde : le serveur envoie un `server.heartbeat` toutes les
   * 10 s ; sans aucune ligne pendant WATCHDOG_MS (connexion à moitié ouverte après une mise en
   * veille ou un changement de réseau), la lecture est annulée et le flux reconnecté (#61).
   */
  async #readStream(outer: Gio.Cancellable, path: string, onData: (raw: string) => void, onOpen: () => void): Promise<void> {
    const cancellable = new Gio.Cancellable();
    const relay = outer.connect(() => cancellable.cancel());
    let watchdog = 0;
    const arm = (): void => {
      if (watchdog !== 0) GLib.source_remove(watchdog);
      watchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WATCHDOG_MS, () => {
        watchdog = 0;
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
      });
    };
    try {
      arm();
      await this.#readEvents(cancellable, path, onData, onOpen, arm);
    } catch (e) {
      // délai du chien de garde dépassé (flux annulé, pas l'appelant) : simple fin de flux
      if (!cancellable.is_cancelled() || outer.is_cancelled()) throw e;
    } finally {
      if (watchdog !== 0) GLib.source_remove(watchdog);
      outer.disconnect(relay);
    }
  }

  async #readEvents(cancellable: Gio.Cancellable, path: string, onData: (raw: string) => void, onOpen: () => void, alive: () => void): Promise<void> {
    const msg = Soup.Message.new('GET', this.#uri(path));
    if (msg === null) throw new Error(`URL invalide : ${this.url}`);
    msg.get_request_headers().append('Accept', 'text/event-stream');
    this.#authorize(msg);
    const input = await this.#events.send_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
    const status: number = msg.get_status();
    if (status !== 200) throw new HttpError(status, `${path} : HTTP ${status}`);
    onOpen();
    const lines = new Gio.DataInputStream({ baseStream: input, closeBaseStream: true });
    let data: string[] = [];
    try {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- lecture séquentielle d'un flux SSE
        const [bytes] = await lines.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
        if (bytes === null) return; // fin du flux
        alive();
        const line = decoder.decode(bytes).replace(/\r$/u, '');
        if (line === '') {
          if (data.length > 0) onData(data.join('\n'));
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

/** Type des événements à haute fréquence (streaming), filtrables avant analyse. */
// en tête de la charge utile seulement (`{"payload":{"id"?,"type":…,"properties":{"sessionID":…`) : un
// objet imbriqué du même nom ne peut pas faire ignorer un autre événement
const STREAM_TYPE = /"payload":\{(?:"id":"[^"]*",)?"type":"(message\.[a-z.]+|session\.diff|todo\.updated)","properties":\{"sessionID":"([^"]+)"/u;

function dispatch(raw: string, onEvent: (e: AppEventEnvelope) => void, skip: ((type: string, sessionID: string) => boolean) | null): void {
  if (skip !== null) {
    const m = STREAM_TYPE.exec(raw);
    if (m?.[1] !== undefined && m[2] !== undefined && skip(m[1], m[2])) return;
  }
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
