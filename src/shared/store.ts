// État réactif partagé : projets, sessions et activité, synchronisés avec le serveur opencode.
import GLib from 'gi://GLib';
import { createState, type Accessor } from 'gnim';
import type { OpencodeClient } from './client.ts';
import { errorMessage } from './errors.ts';
import type { Project, Session, SessionEvent } from './schemas.ts';
import { listenV2 } from './v2/client.ts';
import * as E from './v2/events.ts';
import { appProject, Project as ProjectV2 } from './v2/schemas.ts';
import type * as z from 'zod/mini';

/** Événement v2 d'une session, transmis aux conversations ouvertes (#171). */
export interface SessionEventV2 {
  readonly type: string;
  readonly created: number;
  readonly data: unknown;
}

export type Activity = 'idle' | 'busy' | 'retry' | 'question' | 'permission';

export interface SessionView {
  readonly session: Session;
  readonly activity: Activity;
  /** l'agent a fini de répondre et la session n'a pas été ouverte depuis */
  readonly unread: boolean;
}

/**
 * Un « projet » côté app : un dépôt opencode, ou un simple répertoire pour les sessions
 * hors git (qu'opencode range toutes dans le projet `global`).
 */
export interface ProjectView {
  readonly key: string;
  readonly name: string;
  readonly path: string;
  readonly vcs: boolean;
  readonly sessions: readonly SessionView[];
  /** sessions où l'agent travaille (busy / retry) */
  readonly working: number;
  /** sessions qui attendent une réponse de l'utilisateur (question / permission) */
  readonly waiting: number;
  /** sessions non lues (réponse de l'agent pas encore vue) */
  readonly unread: number;
  readonly updated: number;
}

/** L'agent attend une réponse de l'utilisateur. */
export const isWaiting = (a: Activity): boolean => a === 'question' || a === 'permission';
/** L'agent travaille. */
export const isWorking = (a: Activity): boolean => a === 'busy' || a === 'retry';

/**
 * Le statut, les permissions et les questions sont propres à chaque instance (répertoire) d'opencode.
 * Au chargement, ils ne sont interrogés que pour les répertoires des sessions récentes : interroger
 * un répertoire y démarre une instance, coûteux pour des dizaines de projets.
 */
const RECENT_MS = 24 * 3600 * 1000;

export type Connection = { state: 'connecting' } | { state: 'connected'; version: string } | { state: 'error'; message: string };

const GLOBAL = 'global';

/** Demande (permission, formulaire) d'un événement : session, identifiant, posée ou réglée. */
function requestOf(type: string, data: unknown): { sessionID: string; id: string; asked: boolean } | null {
  const parse = <S extends z.ZodMiniType>(s: S): z.output<S> | null => {
    const r = s.safeParse(data);
    return r.success ? r.data : null;
  };
  switch (type) {
    case 'permission.asked': {
      const d = parse(E.PermissionAsked);
      return d === null ? null : { sessionID: d.sessionID, id: d.id, asked: true };
    }
    case 'permission.replied': {
      const d = parse(E.PermissionReplied);
      return d === null ? null : { sessionID: d.sessionID, id: d.requestID, asked: false };
    }
    case 'form.created': {
      const d = parse(E.FormCreated);
      return d === null ? null : { sessionID: d.form.sessionID, id: d.form.id, asked: true };
    }
    default: {
      const d = parse(E.FormSettled);
      return d === null ? null : { sessionID: d.sessionID, id: d.id, asked: false };
    }
  }
}
const home = GLib.get_home_dir();
export const prettyPath = (p: string): string => (p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

/** Sous-agents gardés en mémoire (suivi de leurs cartes dans les conversations). */
const MAX_CHILDREN = 300;

interface ReloadChanges {
  readonly info: Set<string>;
  readonly activity: Set<string>;
}

interface ActivitySnapshot {
  readonly status: Map<string, 'busy' | 'retry'>;
  readonly permissions: Map<string, Set<string>>;
  readonly questions: Map<string, Set<string>>;
}

export class Store {
  readonly projects: Accessor<readonly ProjectView[]>;
  readonly connection: Accessor<Connection>;
  /** Sessions de sous-agents (`parentID`) vues depuis le démarrage, avec leur activité. */
  readonly children: Accessor<ReadonlyMap<string, SessionView>>;
  readonly client: OpencodeClient;

  readonly #setProjects: (v: readonly ProjectView[]) => void;
  readonly #setConnection: (v: Connection) => void;
  readonly #setChildren: (v: ReadonlyMap<string, SessionView>) => void;
  /** sessions de sous-agents (hors barre latérale) */
  readonly #children = new Map<string, Session>();
  readonly #projects = new Map<string, Project>();
  readonly #sessions = new Map<string, Session>();
  readonly #status = new Map<string, 'busy' | 'retry'>();
  /** sessionID -> demandes de permission en attente */
  readonly #permissions = new Map<string, Set<string>>();
  /** sessionID -> questions en attente */
  readonly #questions = new Map<string, Set<string>>();
  /** sessionID -> abonnés aux événements de messages (conversations ouvertes) */
  readonly #messageListeners = new Map<string, Set<(e: SessionEvent) => void>>();
  readonly #errorListeners = new Set<(sessionID: string, message: string) => void>();
  /** conversations ouvertes : rechargées à chaque reconnexion (événements manqués) */
  readonly #reconnectListeners = new Set<() => void>();
  #connectedOnce = false;
  #childrenSignature = '';
  /** sessions non lues (tenu par l'app, persistant dans ses réglages) */
  #unread: ReadonlySet<string> = new Set();
  /** activité héritée des sous-agents, invalidée à chaque changement (#inherited) */
  #inheritedCache: ReadonlyMap<string, Activity> | null = null;
  /** vues de la dernière publication, réutilisées si rien n'a changé (#157) */
  #views = new Map<string, SessionView>();
  #projectViews = new Map<string, ProjectView>();
  #byWorktree = new Map<string, Project>();
  /** sessions en cours de chargement par #discover */
  readonly #discovering = new Set<string>();
  /** sessions chargées par #discover sans parent (ou introuvables) : pas rechargées */
  readonly #roots = new Set<string>();
  /** sessions cachées (questions annexes) : absentes des projets */
  #hidden: ReadonlySet<string> = new Set();
  /** numéro du dernier rechargement (les réponses des précédents sont ignorées) */
  #reloadGen = 0;
  /** sessions changées par un événement pendant le rechargement en cours */
  #changes: ReloadChanges | null = null;
  #stop: (() => void) | null = null;
  #refreshQueued = false;

  constructor(client: OpencodeClient) {
    this.client = client;
    const [projects, setProjects] = createState<readonly ProjectView[]>([]);
    const [connection, setConnection] = createState<Connection>({ state: 'connecting' });
    this.projects = projects;
    this.connection = connection;
    this.#setProjects = setProjects;
    this.#setConnection = setConnection;
    const [children, setChildren] = createState<ReadonlyMap<string, SessionView>>(new Map());
    this.children = children;
    this.#setChildren = setChildren;
  }

  start(): void {
    this.#stop ??= listenV2(
      this.client,
      (json) => this.#onEvent(json),
      (connected, error) => {
        if (connected) {
          void this.reload();
          if (this.#connectedOnce) for (const fn of this.#reconnectListeners) fn();
          this.#connectedOnce = true;
        } else this.#setConnection({ state: 'error', message: error ?? 'déconnecté' });
      },
    );
  }

  stop(): void {
    this.#stop?.();
    this.#stop = null;
  }

  /**
   * Recharge l'état complet (à la connexion, ou manuellement). Les événements reçus pendant le
   * chargement sont plus récents que l'instantané : les sessions qu'ils touchent gardent leur
   * état courant. Un rechargement plus récent rend les précédents caducs (#63).
   */
  async reload(): Promise<void> {
    const gen = ++this.#reloadGen;
    const changes: ReloadChanges = { info: new Set(), activity: new Set() };
    this.#changes = changes;
    try {
      const [health, projects, sessions] = await Promise.all([this.client.health(), this.client.projects(), this.client.sessions()]);
      if (gen !== this.#reloadGen) return;
      this.#projects.clear();
      for (const p of projects) this.#projects.set(p.id, p);
      const next = new Map(sessions.map((s) => [s.id, s] as const));
      for (const id of changes.info) {
        const current = this.#sessions.get(id);
        if (current === undefined) next.delete(id);
        else next.set(id, current);
      }
      this.#sessions.clear();
      for (const [id, s] of next) this.#sessions.set(id, s);
      this.#setConnection({ state: 'connected', version: health.version });
      this.#publish();
      const activity = await this.#loadActivity(sessions);
      if (gen !== this.#reloadGen) return;
      this.#applyActivity(activity, changes.activity);
      this.#inheritedCache = null;
      for (const id of [...this.#permissions.keys(), ...this.#questions.keys()]) this.#discover(id);
      this.#publish();
    } catch (e) {
      if (gen === this.#reloadGen) this.#setConnection({ state: 'error', message: errorMessage(e) });
    } finally {
      if (gen === this.#reloadGen) this.#changes = null;
    }
  }

  /** Statut, permissions et questions en attente des répertoires récemment actifs. */
  async #loadActivity(sessions: readonly Session[]): Promise<ActivitySnapshot> {
    const since = Date.now() - RECENT_MS;
    const dirs = [...new Set(sessions.filter((s) => (s.time.updated ?? s.time.created) >= since).map((s) => s.directory))];
    const [statuses, results] = await Promise.all([
      this.client.statuses().catch(() => ({})),
      Promise.all(
        dirs.map(async (dir) => {
          try {
            const [permissions, forms] = await Promise.all([this.client.v2.permissions(dir), this.client.v2.forms(dir)]);
            return { permissions, forms };
          } catch {
            return null; // répertoire supprimé, instance en erreur… : ignoré
          }
        }),
      ),
    ]);
    const snapshot: ActivitySnapshot = { status: new Map(), permissions: new Map(), questions: new Map() };
    for (const id of Object.keys(statuses)) snapshot.status.set(id, 'busy');
    for (const r of results) {
      if (r === null) continue;
      for (const p of r.permissions) this.#track(snapshot.permissions, p.sessionID, p.id, true);
      for (const q of r.forms) this.#track(snapshot.questions, q.sessionID, q.id, true);
    }
    return snapshot;
  }

  /** Remplace l'activité par l'instantané, sauf pour les sessions changées depuis par un événement. */
  #applyActivity(snapshot: ActivitySnapshot, keep: ReadonlySet<string>): void {
    const pairs: [Map<string, unknown>, Map<string, unknown>][] = [
      [this.#status, snapshot.status],
      [this.#permissions, snapshot.permissions],
      [this.#questions, snapshot.questions],
    ];
    for (const [current, next] of pairs) {
      for (const id of keep) {
        const value = current.get(id);
        if (value === undefined) next.delete(id);
        else next.set(id, value);
      }
      current.clear();
      for (const [id, value] of next) current.set(id, value);
    }
  }

  /** Ajoute / retire une demande en attente d'une session. */
  #track(map: Map<string, Set<string>>, sessionID: string, id: string | undefined, add: boolean): void {
    this.#inheritedCache = null;
    const set = map.get(sessionID) ?? new Set<string>();
    if (add && id !== undefined) set.add(id);
    // id inconnu à la réponse : on considère la session comme répondue
    else if (id === undefined || !set.delete(id)) set.clear();
    if (set.size === 0) map.delete(sessionID);
    else map.set(sessionID, set);
  }

  /** S'abonne aux événements de messages d'une session. Retourne la fonction de désabonnement. */
  /** Sessions non lues (affichage). */
  setUnread(ids: ReadonlySet<string>): void {
    if (ids.size === this.#unread.size && [...ids].every((id) => this.#unread.has(id))) return;
    this.#unread = ids;
    // différé : souvent appelé depuis un abonné de `projects` (pas de publication ré-entrante)
    this.#publishSoon();
  }

  /** Sessions cachées (questions annexes, #153). */
  setHidden(ids: ReadonlySet<string>): void {
    if (ids.size === this.#hidden.size && [...ids].every((id) => this.#hidden.has(id))) return;
    this.#hidden = ids;
    this.#publish();
  }

  isHidden(sessionID: string): boolean {
    return this.#hidden.has(sessionID);
  }

  /** Appelé à chaque reconnexion au flux d'événements (pas à la première connexion). */
  onReconnect(fn: () => void): () => void {
    this.#reconnectListeners.add(fn);
    return () => {
      this.#reconnectListeners.delete(fn);
    };
  }

  onSessionEvents(sessionID: string, fn: (e: SessionEvent) => void): () => void {
    const set = this.#messageListeners.get(sessionID) ?? new Set();
    set.add(fn);
    this.#messageListeners.set(sessionID, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.#messageListeners.delete(sessionID);
    };
  }

  /** Événements v2 d'une session (conversations ouvertes). Retourne la fonction de désabonnement. */
  onSessionEventsV2(sessionID: string, fn: (e: SessionEventV2) => void): () => void {
    const set = this.#listenersV2.get(sessionID) ?? new Set();
    set.add(fn);
    this.#listenersV2.set(sessionID, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.#listenersV2.delete(sessionID);
    };
  }

  readonly #listenersV2 = new Map<string, Set<(e: SessionEventV2) => void>>();

  /** Ajoute ou met à jour une session localement (avant l'événement du serveur). */
  upsertSession(session: Session): void {
    if (session.parentID !== undefined) return;
    this.#sessions.set(session.id, session);
    this.#publish();
  }

  /** Retire une session localement (avant l'événement du serveur). */
  removeSession(sessionID: string): void {
    this.#sessions.delete(sessionID);
    this.#status.delete(sessionID);
    this.#permissions.delete(sessionID);
    this.#questions.delete(sessionID);
    this.#publish();
  }

  /** Session connue (racine), si présente. */
  /** Première demande de permission en attente d'une session (pour y répondre depuis une notification). */
  pendingPermission(sessionID: string): string | undefined {
    for (const id of [sessionID, ...this.#descendants(sessionID)]) {
      const first = [...(this.#permissions.get(id) ?? [])][0];
      if (first !== undefined) return first;
    }
    return undefined;
  }

  /** Sous-agents connus de la session, à toute profondeur (#154). */
  #descendants(sessionID: string): string[] {
    const out: string[] = [];
    const queue = [sessionID];
    for (let id = queue.shift(); id !== undefined; id = queue.shift())
      for (const c of this.#children.values())
        if (c.parentID === id && !out.includes(c.id)) {
          out.push(c.id);
          queue.push(c.id);
        }
    return out;
  }

  /** Session d'une demande inconnue (sous-agent pas encore vu) : chargée pour connaître son parent. */
  #discover(sessionID: string): void {
    if (this.#sessions.has(sessionID) || this.#children.has(sessionID) || this.#discovering.has(sessionID) || this.#roots.has(sessionID)) return;
    this.#discovering.add(sessionID);
    this.client
      .session(sessionID)
      .then((s) => {
        if (s.parentID === undefined) this.#roots.add(s.id);
        else {
          this.#children.set(s.id, s);
    this.#inheritedCache = null;
          this.#inheritedCache = null;
          this.#discover(s.parentID);
          this.#publishSoon();
        }
        return null;
      })
      .catch((e: unknown) => {
        // session supprimée : pas redemandée à chaque rechargement
        this.#roots.add(sessionID);
        console.error(e);
      })
      .finally(() => {
        this.#discovering.delete(sessionID);
      });
  }

  /** S'abonne aux erreurs de session (`session.error`). */
  onSessionError(fn: (sessionID: string, message: string) => void): () => void {
    this.#errorListeners.add(fn);
    return () => {
      this.#errorListeners.delete(fn);
    };
  }

  session(sessionID: string): Session | undefined {
    return this.#sessions.get(sessionID);
  }

  /** Charge une session de sous-agent (inconnue tant qu'aucun événement ne l'a signalée). */
  async loadChild(sessionID: string): Promise<void> {
    if (this.#children.has(sessionID)) return;
    const s = await this.client.session(sessionID);
    if (s.parentID === undefined) return;
    this.#children.set(s.id, s);
    this.#publish();
  }

  /** Événement v2 (`GET /api/event`). */
  #onEvent(json: unknown): void {
    const env = E.Envelope.safeParse(json);
    if (!env.success) return;
    const { type, data } = env.data;
    const created = env.data.created ?? Date.now();
    const sid = E.Sid.safeParse(data);
    const sessionID = sid.success ? sid.data.sessionID : null;
    // conversations ouvertes : tous les événements de leur session (streaming compris)
    if (sessionID !== null) for (const fn of this.#listenersV2.get(sessionID) ?? []) fn({ type, created, data });
    this.#inheritedCache = null;
    switch (type) {
      case 'session.created':
      case 'session.renamed':
      case 'session.moved':
      case 'session.archived':
      case 'session.unarchived':
      case 'session.forked':
      case 'session.metadata.updated':
      case 'session.revert.staged':
      case 'session.revert.cleared':
      case 'session.revert.committed':
        // l'événement ne porte pas la session complète : relue
        if (sessionID !== null) {
          this.#changes?.info.add(sessionID);
          this.#refetch(sessionID);
        }
        return;
      case 'session.deleted':
        if (sessionID !== null) this.#forget(sessionID);
        break;
      case 'session.execution.started':
        if (sessionID === null) return;
        this.#changes?.activity.add(sessionID);
        this.#status.set(sessionID, 'busy');
        this.#touch(sessionID, created);
        break;
      case 'session.retry.scheduled':
        if (sessionID === null) return;
        this.#changes?.activity.add(sessionID);
        this.#status.set(sessionID, 'retry');
        break;
      case 'session.execution.failed':
      case 'session.execution.succeeded':
      case 'session.execution.interrupted': {
        if (sessionID === null) return;
        this.#changes?.activity.add(sessionID);
        this.#status.delete(sessionID);
        this.#permissions.delete(sessionID);
        this.#questions.delete(sessionID);
        this.#touch(sessionID, created);
        const failed = type === 'session.execution.failed' ? E.ExecutionFailed.safeParse(data) : null;
        if (failed?.success === true) for (const fn of this.#errorListeners) fn(sessionID, failed.data.error.message);
        break;
      }
      case 'permission.asked':
      case 'permission.replied':
      case 'form.created':
      case 'form.replied':
      case 'form.cancelled': {
        const r = requestOf(type, data);
        if (r === null) return;
        // la conversation d'une demande de sous-agent écoute aussi la session de la demande
        if (sessionID === null) for (const fn of this.#listenersV2.get(r.sessionID) ?? []) fn({ type, created, data });
        this.#changes?.activity.add(r.sessionID);
        this.#track(type.startsWith('form') ? this.#questions : this.#permissions, r.sessionID, r.id, r.asked);
        if (r.asked) this.#discover(r.sessionID);
        break;
      }
      case 'project.updated': {
        const p = ProjectV2.safeParse(data);
        if (!p.success) return;
        this.#projects.set(p.data.id, appProject(p.data));
        break;
      }
      default:
        return;
    }
    this.#publishSoon();
  }

  /** Activité récente : la session remonte en tête de son projet. */
  #touch(sessionID: string, at: number): void {
    const s = this.#sessions.get(sessionID) ?? this.#children.get(sessionID);
    if (s === undefined || s.time.updated >= at) return;
    const next = { ...s, time: { ...s.time, updated: at } };
    if (s.parentID === undefined) this.#sessions.set(sessionID, next);
    else this.#children.set(sessionID, next);
  }

  #forget(sessionID: string): void {
    for (const c of this.#children.values()) if (c.parentID === sessionID) this.#children.delete(c.id);
    this.#changes?.info.add(sessionID);
    this.#changes?.activity.add(sessionID);
    this.#sessions.delete(sessionID);
    this.#children.delete(sessionID);
    this.#status.delete(sessionID);
    this.#permissions.delete(sessionID);
    this.#questions.delete(sessionID);
  }

  /** Relit une session (créée, renommée, archivée…) ; archivée : retirée des projets. */
  #refetch(sessionID: string): void {
    this.client
      .session(sessionID)
      .then((s) => {
        if (s.time.archived !== undefined) this.#forget(s.id);
        else if (s.parentID === undefined) this.#sessions.set(s.id, s);
        else this.#children.set(s.id, s);
        this.#inheritedCache = null;
        this.#publishSoon();
        return null;
      })
      .catch((e: unknown) => {
        console.error(e);
      });
  }

  /** Regroupe les mises à jour rapprochées (le streaming émet beaucoup d'événements). */
  #publishSoon(): void {
    if (this.#refreshQueued) return;
    this.#refreshQueued = true;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      this.#refreshQueued = false;
      this.#publish();
      return GLib.SOURCE_REMOVE;
    });
  }

  /**
   * Activité d'une session ; une session racine remonte aussi les demandes en attente de ses
   * sous-agents (question, permission : #154).
   */
  activity(sessionID: string): Activity {
    if ((this.#questions.get(sessionID)?.size ?? 0) > 0) return 'question';
    if ((this.#permissions.get(sessionID)?.size ?? 0) > 0) return 'permission';
    // remontée des sous-agents : sessions racines seulement (comme avant #157)
    return (this.#sessions.has(sessionID) ? this.#inherited().get(sessionID) : undefined) ?? this.#status.get(sessionID) ?? 'idle';
  }

  /**
   * Demandes des sous-agents remontées à leurs ancêtres : calculées en partant des demandes en
   * attente (peu nombreuses) vers la racine, pas en parcourant les sous-agents de chaque session (#157).
   */
  #inherited(): ReadonlyMap<string, Activity> {
    if (this.#inheritedCache !== null) return this.#inheritedCache;
    const out = new Map<string, Activity>();
    const climb = (id: string, a: Activity): void => {
      const seen = new Set<string>();
      for (let c = this.#children.get(id); c?.parentID !== undefined && !seen.has(c.id); c = this.#children.get(c.parentID)) {
        seen.add(c.id);
        // question prioritaire sur permission
        if (out.get(c.parentID) !== 'question') out.set(c.parentID, a);
      }
    };
    for (const [id, set] of this.#permissions) if (set.size > 0) climb(id, 'permission');
    for (const [id, set] of this.#questions) if (set.size > 0) climb(id, 'question');
    this.#inheritedCache = out;
    return out;
  }

  #projectOf(s: Session): { key: string; path: string; vcs: boolean; name?: string } {
    // session hors git (`global`) dont le répertoire est depuis devenu un projet git
    // (ex. sessions créées avant le premier commit) : rangée avec ce projet, pas en doublon
    const project = s.projectID === GLOBAL ? this.#byWorktree.get(s.directory) : this.#projects.get(s.projectID);
    if (project === undefined || project.id === GLOBAL) return { key: `dir:${s.directory}`, path: s.directory, vcs: false };
    return { key: project.id, path: project.worktree, vcs: project.vcs !== undefined, ...(project.name === undefined ? {} : { name: project.name }) };
  }

  /**
   * Sous-agents : au plus MAX_CHILDREN (les plus récemment actifs) ; republiés seulement si une
   * session ou une activité change, pas à chaque publication du streaming (#102).
   */
  #publishChildren(): void {
    if (this.#children.size > MAX_CHILDREN) {
      // sous-agents en attente et leurs ancêtres gardés : la demande remonte à la session racine
      const keep = new Set<string>();
      for (const id of [...this.#questions.keys(), ...this.#permissions.keys()])
        for (let c = this.#children.get(id); c !== undefined && !keep.has(c.id); c = c.parentID === undefined ? undefined : this.#children.get(c.parentID)) keep.add(c.id);
      const old = [...this.#children.values()].filter((c) => !keep.has(c.id)).toSorted((a, b) => (a.time.updated ?? a.time.created) - (b.time.updated ?? b.time.created));
      for (const c of old.slice(0, this.#children.size - MAX_CHILDREN)) this.#children.delete(c.id);
    }
    // activité de toutes les sessions aussi : les cartes de sous-agents relisent store.activity(id),
    // y compris pour un sous-agent pas encore chargé
    const active = [...new Set([...this.#status.keys(), ...this.#questions.keys(), ...this.#permissions.keys()])].map((id) => `${id}:${this.activity(id)}`);
    const signature = [...[...this.#children.values()].map((c) => `${c.id}:${c.time.updated ?? ''}:${c.title}:${this.activity(c.id)}`), ...active].join('|');
    if (signature === this.#childrenSignature) return;
    this.#childrenSignature = signature;
    this.#setChildren(new Map([...this.#children.values()].map((c) => [c.id, { session: c, activity: this.activity(c.id), unread: false }])));
  }

  /** Vue d'une session (dernière publication), sans parcourir les projets. */
  sessionView(sessionID: string): SessionView | undefined {
    return this.#views.get(sessionID);
  }

  /** Chemin du projet d'une session (dernière publication). */
  projectPathOf(sessionID: string): string | undefined {
    return this.#projectOfSession.get(sessionID);
  }

  #projectOfSession = new Map<string, string>();

  #publish(): void {
    this.#inheritedCache = null;
    this.#byWorktree = new Map([...this.#projects.values()].filter((p) => p.id !== GLOBAL).map((p) => [p.worktree, p]));
    const views = new Map<string, SessionView>();
    const projectOfSession = new Map<string, string>();
    const groups = new Map<string, { path: string; vcs: boolean; name: string; sessions: SessionView[] }>();
    for (const s of this.#sessions.values()) {
      if (this.#hidden.has(s.id)) continue;
      const p = this.#projectOf(s);
      let g = groups.get(p.key);
      if (g === undefined) {
        g = { path: p.path, vcs: p.vcs, name: p.name ?? GLib.path_get_basename(p.path), sessions: [] };
        groups.set(p.key, g);
      }
      const activity = this.activity(s.id);
      const unread = this.#unread.has(s.id);
      // même objet si rien n'a changé : les abonnés en aval ne recalculent pas
      const old = this.#views.get(s.id);
      const v = old !== undefined && old.session === s && old.activity === activity && old.unread === unread ? old : { session: s, activity, unread };
      views.set(s.id, v);
      projectOfSession.set(s.id, p.path);
      g.sessions.push(v);
    }
    // projets git connus sans session (le serveur les a vus mais tout a été supprimé)
    for (const p of this.#projects.values()) {
      if (p.id !== GLOBAL && !groups.has(p.id)) {
        groups.set(p.id, { path: p.worktree, vcs: p.vcs !== undefined, name: p.name ?? GLib.path_get_basename(p.worktree), sessions: [] });
      }
    }
    this.#views = views;
    this.#projectOfSession = projectOfSession;
    const projectViews = new Map<string, ProjectView>();
    const list: ProjectView[] = [...groups.entries()].map(([key, g]) => {
      const sessions = g.sessions.toSorted((a, b) => (b.session.time.updated ?? b.session.time.created) - (a.session.time.updated ?? a.session.time.created));
      const first = sessions[0]?.session;
      const next: ProjectView = {
        key,
        name: g.name,
        path: g.path,
        vcs: g.vcs,
        sessions,
        working: sessions.filter((s) => isWorking(s.activity)).length,
        waiting: sessions.filter((s) => isWaiting(s.activity)).length,
        unread: sessions.filter((s) => s.unread).length,
        updated: first === undefined ? (this.#projects.get(key)?.time?.updated ?? 0) : (first.time.updated ?? first.time.created),
      };
      const old = this.#projectViews.get(key);
      const same =
        old !== undefined &&
        old.name === next.name &&
        old.path === next.path &&
        old.vcs === next.vcs &&
        old.updated === next.updated &&
        old.sessions.length === sessions.length &&
        old.sessions.every((v, i) => v === sessions[i]);
      const view = same ? old : next;
      projectViews.set(key, view);
      return view;
    });
    this.#projectViews = projectViews;
    this.#publishChildren();
    // projets avec sessions d'abord (activité récente en tête), projets vides en bas
    const sorted = list.toSorted((a, b) => Number(a.sessions.length === 0) - Number(b.sessions.length === 0) || b.updated - a.updated);
    const previous = this.projects.peek();
    // rien n'a changé : pas de publication (aucun abonné ne recalcule)
    if (sorted.length === previous.length && sorted.every((p, i) => p === previous[i])) return;
    this.#setProjects(sorted);
  }
}
