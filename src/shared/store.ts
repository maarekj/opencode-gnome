// État réactif partagé : projets, sessions et activité, synchronisés avec le serveur opencode.
import GLib from 'gi://GLib';
import { createState, type Accessor } from 'gnim';
import type { OpencodeClient } from './client.ts';
import { errorMessage } from './errors.ts';
import type { AppEventEnvelope, Project, Session, SessionEvent } from './schemas.ts';

export type Activity = 'idle' | 'busy' | 'retry' | 'permission';

export interface SessionView {
  readonly session: Session;
  readonly activity: Activity;
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
  readonly active: number;
  readonly updated: number;
}

export type Connection = { state: 'connecting' } | { state: 'connected'; version: string } | { state: 'error'; message: string };

const GLOBAL = 'global';
const home = GLib.get_home_dir();
export const prettyPath = (p: string): string => (p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

export class Store {
  readonly projects: Accessor<readonly ProjectView[]>;
  readonly connection: Accessor<Connection>;
  readonly client: OpencodeClient;

  readonly #setProjects: (v: readonly ProjectView[]) => void;
  readonly #setConnection: (v: Connection) => void;
  readonly #projects = new Map<string, Project>();
  readonly #sessions = new Map<string, Session>();
  readonly #status = new Map<string, 'busy' | 'retry'>();
  /** sessionID -> demandes de permission en attente */
  readonly #permissions = new Map<string, Set<string>>();
  /** sessionID -> abonnés aux événements de messages (conversations ouvertes) */
  readonly #messageListeners = new Map<string, Set<(e: SessionEvent) => void>>();
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
  }

  start(): void {
    this.#stop ??= this.client.listen(
      (e) => this.#onEvent(e),
      (connected, error) => {
        if (connected) void this.reload();
        else this.#setConnection({ state: 'error', message: error ?? 'déconnecté' });
      },
    );
  }

  stop(): void {
    this.#stop?.();
    this.#stop = null;
  }

  /** Recharge l'état complet (à la connexion, ou manuellement). */
  async reload(): Promise<void> {
    try {
      const [health, projects, sessions, statuses] = await Promise.all([
        this.client.health(),
        this.client.projects(),
        this.client.sessions(),
        this.client.statuses(),
      ]);
      this.#projects.clear();
      for (const p of projects) this.#projects.set(p.id, p);
      this.#sessions.clear();
      for (const s of sessions) this.#sessions.set(s.id, s);
      this.#status.clear();
      for (const [id, st] of Object.entries(statuses)) {
        if (st.type === 'busy' || st.type === 'retry') this.#status.set(id, st.type);
      }
      this.#setConnection({ state: 'connected', version: health.version });
      this.#publish();
    } catch (e) {
      this.#setConnection({ state: 'error', message: errorMessage(e) });
    }
  }

  /** S'abonne aux événements de messages d'une session. Retourne la fonction de désabonnement. */
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

  /** Marque une session comme en attente d'une réponse de l'utilisateur (question). */
  #attention(sessionID: string, on: boolean): void {
    const set = this.#permissions.get(sessionID) ?? new Set<string>();
    if (on) set.add('question');
    else set.delete('question');
    if (set.size === 0) this.#permissions.delete(sessionID);
    else this.#permissions.set(sessionID, set);
  }

  /** Ajoute ou met à jour une session localement (avant l'événement du serveur). */
  upsertSession(session: Session): void {
    if (session.parentID !== undefined) return;
    this.#sessions.set(session.id, session);
    this.#publish();
  }

  /** Session connue (racine), si présente. */
  session(sessionID: string): Session | undefined {
    return this.#sessions.get(sessionID);
  }

  #onEvent({ event }: AppEventEnvelope): void {
    switch (event.type) {
      case 'message.updated':
      case 'message.removed':
      case 'message.part.updated':
      case 'message.part.removed':
      case 'message.part.delta':
      case 'session.diff':
        // haute fréquence (streaming) : uniquement pour les conversations ouvertes
        this.#notify(event);
        return;
      case 'server.connected':
        return;
      case 'session.created':
      case 'session.updated':
        if (event.properties.info.parentID === undefined) this.#sessions.set(event.properties.info.id, event.properties.info);
        break;
      case 'session.deleted':
        this.#sessions.delete(event.properties.sessionID);
        this.#status.delete(event.properties.sessionID);
        this.#permissions.delete(event.properties.sessionID);
        break;
      case 'session.status': {
        const { sessionID, status } = event.properties;
        if (status.type === 'busy' || status.type === 'retry') this.#status.set(sessionID, status.type);
        else this.#status.delete(sessionID);
        break;
      }
      case 'session.idle':
        this.#status.delete(event.properties.sessionID);
        this.#permissions.delete(event.properties.sessionID);
        break;
      case 'question.asked':
      case 'question.v2.asked':
      case 'question.replied':
      case 'question.v2.replied':
      case 'question.rejected':
      case 'question.v2.rejected':
        this.#notify(event);
        if (event.type.endsWith('asked')) this.#attention(event.properties.sessionID, true);
        else this.#attention(event.properties.sessionID, false);
        break;
      case 'permission.asked':
      case 'permission.v2.asked': {
        this.#notify(event);
        const set = this.#permissions.get(event.properties.sessionID) ?? new Set<string>();
        set.add(event.properties.id);
        this.#permissions.set(event.properties.sessionID, set);
        break;
      }
      case 'permission.replied':
      case 'permission.v2.replied':
        this.#notify(event);
        this.#permissions.delete(event.properties.sessionID);
        break;
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
    if ((this.#permissions.get(sessionID)?.size ?? 0) > 0) return 'permission';
    return this.#status.get(sessionID) ?? 'idle';
  }

  #projectOf(s: Session): { key: string; path: string; vcs: boolean; name?: string } {
    const project = this.#projects.get(s.projectID);
    if (s.projectID === GLOBAL || project === undefined) return { key: `dir:${s.directory}`, path: s.directory, vcs: false };
    return { key: project.id, path: project.worktree, vcs: project.vcs !== undefined, ...(project.name === undefined ? {} : { name: project.name }) };
  }

  #publish(): void {
    const groups = new Map<string, { path: string; vcs: boolean; name: string; sessions: SessionView[] }>();
    for (const s of this.#sessions.values()) {
      const p = this.#projectOf(s);
      let g = groups.get(p.key);
      if (g === undefined) {
        g = { path: p.path, vcs: p.vcs, name: p.name ?? GLib.path_get_basename(p.path), sessions: [] };
        groups.set(p.key, g);
      }
      g.sessions.push({ session: s, activity: this.activity(s.id) });
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
        active: sessions.filter((s) => s.activity !== 'idle').length,
        updated: first === undefined ? (this.#projects.get(key)?.time?.updated ?? 0) : (first.time.updated ?? first.time.created),
      };
    });
    this.#setProjects(views.toSorted((a, b) => b.updated - a.updated));
  }
}
