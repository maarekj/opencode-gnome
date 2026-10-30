// État réactif partagé : projets, sessions et activité, synchronisés avec le serveur opencode.
import GLib from 'gi://GLib';
import { createState, type Accessor } from 'gnim';
import type { OpencodeClient } from './client.ts';
import { errorMessage } from './errors.ts';
import type { AppEventEnvelope, Project, Session, SessionEvent } from './schemas.ts';

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
    this.#stop ??= this.client.listen(
      (e) => this.#onEvent(e),
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
    const results = await Promise.all(
      dirs.map(async (dir) => {
        try {
          const [statuses, permissions, questions] = await Promise.all([this.client.statuses(dir), this.client.permissions(dir), this.client.questions(dir)]);
          return { statuses, permissions, questions };
        } catch {
          return null; // répertoire supprimé, instance en erreur… : ignoré
        }
      }),
    );
    const snapshot: ActivitySnapshot = { status: new Map(), permissions: new Map(), questions: new Map() };
    for (const r of results) {
      if (r === null) continue;
      for (const [id, st] of Object.entries(r.statuses)) {
        if (st.type === 'busy' || st.type === 'retry') snapshot.status.set(id, st.type);
      }
      for (const p of r.permissions) this.#track(snapshot.permissions, p.sessionID, p.id, true);
      for (const q of r.questions) this.#track(snapshot.questions, q.sessionID, q.id, true);
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
    this.#publish();
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

  #notify(event: SessionEvent): void {
    for (const fn of this.#messageListeners.get(event.properties.sessionID) ?? []) fn(event);
  }

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
    return [...(this.#permissions.get(sessionID) ?? [])][0];
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

  #onEvent({ event }: AppEventEnvelope): void {
    switch (event.type) {
      case 'message.updated':
      case 'message.removed':
      case 'message.part.updated':
      case 'message.part.removed':
      case 'message.part.delta':
      case 'session.diff':
      case 'todo.updated':
        // haute fréquence (streaming) : uniquement pour les conversations ouvertes
        this.#notify(event);
        return;
      case 'server.connected':
        return;
      case 'session.error': {
        const { sessionID, error } = event.properties;
        // interruption volontaire : pas une erreur à signaler
        if (sessionID === undefined || error?.name === 'MessageAbortedError') return;
        const message = error?.data?.message ?? error?.name ?? 'Erreur';
        for (const fn of this.#errorListeners) fn(sessionID, message);
        return;
      }
      case 'session.created':
      case 'session.updated':
        this.#changes?.info.add(event.properties.info.id);
        if (event.properties.info.parentID === undefined) this.#sessions.set(event.properties.info.id, event.properties.info);
        else this.#children.set(event.properties.info.id, event.properties.info);
        break;
      case 'session.deleted':
        for (const c of this.#children.values()) if (c.parentID === event.properties.sessionID) this.#children.delete(c.id);
        this.#changes?.info.add(event.properties.sessionID);
        this.#changes?.activity.add(event.properties.sessionID);
        this.#sessions.delete(event.properties.sessionID);
        this.#children.delete(event.properties.sessionID);
        this.#status.delete(event.properties.sessionID);
        this.#permissions.delete(event.properties.sessionID);
        this.#questions.delete(event.properties.sessionID);
        break;
      case 'session.status': {
        const { sessionID, status } = event.properties;
        this.#changes?.activity.add(sessionID);
        if (status.type === 'busy' || status.type === 'retry') this.#status.set(sessionID, status.type);
        else this.#status.delete(sessionID);
        break;
      }
      case 'session.idle':
        this.#changes?.activity.add(event.properties.sessionID);
        this.#status.delete(event.properties.sessionID);
        this.#permissions.delete(event.properties.sessionID);
        this.#questions.delete(event.properties.sessionID);
        break;
      case 'question.asked':
      case 'question.v2.asked':
      case 'question.replied':
      case 'question.v2.replied':
      case 'question.rejected':
      case 'question.v2.rejected':
      case 'permission.asked':
      case 'permission.v2.asked':
      case 'permission.replied':
      case 'permission.v2.replied': {
        this.#notify(event);
        this.#changes?.activity.add(event.properties.sessionID);
        const asked = event.type.endsWith('asked');
        // demande : `id` ; réponse : `requestID`
        const raw: unknown = asked ? event.properties['id'] : event.properties['requestID'];
        const map = event.type.startsWith('question') ? this.#questions : this.#permissions;
        this.#track(map, event.properties.sessionID, typeof raw === 'string' ? raw : undefined, asked);
        break;
      }
      case 'project.updated':
        this.#projects.set(event.properties.id, event.properties);
        break;
      default:
        return;
    }
    this.#publishSoon();
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

  activity(sessionID: string): Activity {
    if ((this.#questions.get(sessionID)?.size ?? 0) > 0) return 'question';
    if ((this.#permissions.get(sessionID)?.size ?? 0) > 0) return 'permission';
    return this.#status.get(sessionID) ?? 'idle';
  }

  #projectOf(s: Session): { key: string; path: string; vcs: boolean; name?: string } {
    // session hors git (`global`) dont le répertoire est depuis devenu un projet git
    // (ex. sessions créées avant le premier commit) : rangée avec ce projet, pas en doublon
    const project = s.projectID === GLOBAL ? [...this.#projects.values()].find((p) => p.id !== GLOBAL && p.worktree === s.directory) : this.#projects.get(s.projectID);
    if (project === undefined || project.id === GLOBAL) return { key: `dir:${s.directory}`, path: s.directory, vcs: false };
    return { key: project.id, path: project.worktree, vcs: project.vcs !== undefined, ...(project.name === undefined ? {} : { name: project.name }) };
  }

  /**
   * Sous-agents : au plus MAX_CHILDREN (les plus récemment actifs) ; republiés seulement si une
   * session ou une activité change, pas à chaque publication du streaming (#102).
   */
  #publishChildren(): void {
    if (this.#children.size > MAX_CHILDREN) {
      const old = [...this.#children.values()].toSorted((a, b) => (a.time.updated ?? a.time.created) - (b.time.updated ?? b.time.created));
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

  #publish(): void {
    const groups = new Map<string, { path: string; vcs: boolean; name: string; sessions: SessionView[] }>();
    for (const s of this.#sessions.values()) {
      if (this.#hidden.has(s.id)) continue;
      const p = this.#projectOf(s);
      let g = groups.get(p.key);
      if (g === undefined) {
        g = { path: p.path, vcs: p.vcs, name: p.name ?? GLib.path_get_basename(p.path), sessions: [] };
        groups.set(p.key, g);
      }
      g.sessions.push({ session: s, activity: this.activity(s.id), unread: this.#unread.has(s.id) });
    }
    // projets git connus sans session (le serveur les a vus mais tout a été supprimé)
    for (const p of this.#projects.values()) {
      if (p.id !== GLOBAL && !groups.has(p.id)) {
        groups.set(p.id, { path: p.worktree, vcs: p.vcs !== undefined, name: p.name ?? GLib.path_get_basename(p.worktree), sessions: [] });
      }
    }
    const views: ProjectView[] = [...groups.entries()].map(([key, g]) => {
      const sessions = g.sessions.toSorted((a, b) => (b.session.time.updated ?? b.session.time.created) - (a.session.time.updated ?? a.session.time.created));
      const first = sessions[0]?.session;
      return {
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
    });
    this.#publishChildren();
    // projets avec sessions d'abord (activité récente en tête), projets vides en bas
    this.#setProjects(views.toSorted((a, b) => Number(a.sessions.length === 0) - Number(b.sessions.length === 0) || b.updated - a.updated));
  }
}
