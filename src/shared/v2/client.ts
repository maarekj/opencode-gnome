// Client de l'API serveur d'OpenCode 2 (#169, migration #168) : lecture des projets, sessions et
// messages. Transport : celui du client v1 (libsoup, mot de passe, gros corps décodés par
// morceaux) ; GJS n'a ni fetch, ni URL, ni Headers, ni ReadableStream, d'où un client écrit à la
// main plutôt que `@opencode/client`, dont seuls les types servent : chaque appel est vérifié à
// la compilation (entrée et sortie), et chaque schéma zod contre le type officiel (`conforms`).
import type {
  AgentListOutput,
  CommandListOutput,
  FileFindOutput,
  ModelDefaultOutput,
  ModelListOutput,
  SessionCommandInput,
  SessionCompactInput,
  SessionInterruptInput,
  SessionPromptInput,
  SessionRevertStageInput,
  SessionSwitchAgentInput,
  SessionSwitchModelInput,
  VcsDiffInput,
  VcsDiffOutput,
  FormListOutput,
  MessageListInput,
  PermissionRequestListOutput,
  MessageListOutput,
  ProjectListOutput,
  ServerInfo,
  SessionActiveOutput,
  SessionGetOutput,
  SessionListInput,
  SessionCreateInput,
  SessionCreateOutput,
  SessionForkInput,
  SessionForkOutput,
  SessionListOutput,
  SessionRemoveInput,
  SessionUpdateInput,
} from '@opencode/client';
import type Gio from 'gi://Gio';
import type { OpencodeClient } from '../client.ts';
import { HttpError } from '../errors.ts';
import { conforms } from './conforms.ts';
import { AgentList, CommandList, FileFind, ModelDefault, ModelList, VcsDiff, FormList, Info, Messages, PermissionList, Project, Session, SessionPage, Status, type FormV2, type MessageV2, type PermissionV2, type ProjectV2, type SessionV2 } from './schemas.ts';
import * as z from 'zod/mini';

// les schémas acceptent tout ce que le serveur v2 peut renvoyer (vérifié à la compilation)
conforms<ServerInfo, typeof Info>(true);
conforms<ProjectListOutput[number], typeof Project>(true);
conforms<SessionGetOutput, typeof Session>(true);
conforms<SessionCreateOutput, typeof Session>(true);
conforms<SessionForkOutput, typeof Session>(true);
conforms<SessionListOutput, typeof SessionPage>(true);
conforms<MessageListOutput, typeof Messages>(true);
conforms<SessionActiveOutput[string], typeof Status>(true);
conforms<PermissionRequestListOutput, typeof PermissionList>(true);
conforms<FormListOutput, typeof FormList>(true);
conforms<AgentListOutput, typeof AgentList>(true);
conforms<ModelListOutput, typeof ModelList>(true);
conforms<ModelDefaultOutput, typeof ModelDefault>(true);
conforms<CommandListOutput, typeof CommandList>(true);
conforms<FileFindOutput, typeof FileFind>(true);
conforms<VcsDiffOutput, typeof VcsDiff>(true);

/** Requête typée : paramètres de requête tels que décrits par le type d'entrée officiel. */
type Query<T> = { readonly [K in keyof T]?: T[K] extends string | number | boolean | null | undefined ? T[K] : never };
function query<T extends object>(q: Query<T>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(q)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  return out;
}
const seg = encodeURIComponent;

/** Réponse enveloppée `{ data }`. */
const data = <S extends z.ZodMiniType>(s: S): z.ZodMiniObject<{ data: S }> => z.object({ data: s });

/** Une page et le curseur de la suivante (null : dernière page). */
export interface Page<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}

export class OpencodeV2 {
  readonly #http: OpencodeClient;

  constructor(http: OpencodeClient) {
    this.#http = http;
  }

  /** Version et capacités du serveur. */
  info(): Promise<ServerInfo> {
    return this.#http.get('/api/info', Info);
  }

  projects(): Promise<ProjectV2[]> {
    return this.#http.get('/api/project', z.array(Project));
  }

  /** Sessions, plus récentes d'abord ; `cursor` : page suivante. */
  async sessions(input: Omit<SessionListInput, 'parentID'> & { roots?: boolean } = {}): Promise<Page<SessionV2>> {
    const { roots, ...rest } = input;
    // racines seulement : parentID vide côté serveur (`null` sérialisé)
    // le curseur porte déjà l'ordre (le serveur refuse les deux ensemble)
    const r = await this.#http.get('/api/session', SessionPage, query<SessionListInput>({ ...(rest.cursor === undefined ? { order: 'desc' } : {}), ...rest, ...(roots === true ? { parentID: 'null' } : {}) }));
    return { items: r.data, next: r.cursor.next ?? null };
  }

  async session(sessionID: string): Promise<SessionV2> {
    return (await this.#http.get(`/api/session/${seg(sessionID)}`, data(Session))).data;
  }

  async createSession(input: SessionCreateInput): Promise<SessionV2> {
    return (await this.#http.request('POST', '/api/session', data(Session), { body: input })).data;
  }

  async updateSession(input: SessionUpdateInput): Promise<void> {
    const { sessionID, ...body } = input;
    await this.#http.request('PATCH', `/api/session/${seg(sessionID)}`, z.unknown(), { body });
  }

  /** Copie de la session, jusqu'au message `before` exclu. */
  async forkSession(input: SessionForkInput): Promise<SessionV2> {
    const { sessionID, ...body } = input;
    return (await this.#http.request('POST', `/api/session/${seg(sessionID)}/fork`, data(Session), { body })).data;
  }

  async removeSession(input: SessionRemoveInput): Promise<void> {
    await this.#http.request('DELETE', `/api/session/${seg(input.sessionID)}`, z.unknown());
  }

  /** Sessions en cours d'exécution (statut par session). */
  async active(): Promise<Record<string, z.output<typeof Status>>> {
    return (await this.#http.get('/api/session/active', data(z.record(z.string(), Status)))).data;
  }

  /** Permissions en attente dans un dossier. */
  async permissions(directory: string): Promise<PermissionV2[]> {
    return (await this.#http.get('/api/permission/request', PermissionList, { 'location[directory]': directory })).data;
  }

  /** Formulaires (questions) en attente dans un dossier. */
  async forms(directory: string): Promise<FormV2[]> {
    return (await this.#http.get('/api/form', FormList, { 'location[directory]': directory })).data;
  }

  // ---------------------------------------------------------------- envoi et actions (#172)

  /** Message utilisateur (remis à l'agent, ou mis en file s'il travaille). */
  async prompt(input: SessionPromptInput): Promise<void> {
    const { sessionID, ...body } = input;
    await this.#http.request('POST', `/api/session/${seg(sessionID)}/prompt`, z.unknown(), { body });
  }

  async command(input: SessionCommandInput): Promise<void> {
    const { sessionID, ...body } = input;
    await this.#http.request('POST', `/api/session/${seg(sessionID)}/command`, z.unknown(), { body, long: true });
  }

  async switchAgent(input: SessionSwitchAgentInput): Promise<void> {
    const { sessionID, ...body } = input;
    await this.#http.request('POST', `/api/session/${seg(sessionID)}/agent`, z.unknown(), { body });
  }

  async switchModel(input: SessionSwitchModelInput): Promise<void> {
    const { sessionID, ...body } = input;
    await this.#http.request('POST', `/api/session/${seg(sessionID)}/model`, z.unknown(), { body });
  }

  async compact(input: SessionCompactInput): Promise<void> {
    const { sessionID, ...body } = input;
    await this.#http.request('POST', `/api/session/${seg(sessionID)}/compact`, z.unknown(), { body });
  }

  async interrupt(input: SessionInterruptInput): Promise<void> {
    const { sessionID, ...body } = input;
    await this.#http.request('POST', `/api/session/${seg(sessionID)}/interrupt`, z.unknown(), { body });
  }

  /** Annulation préparée : messages masqués à partir de `messageID` (rétablissables). */
  async revertStage(input: SessionRevertStageInput): Promise<void> {
    const { sessionID, ...body } = input;
    await this.#http.request('POST', `/api/session/${seg(sessionID)}/revert/stage`, z.unknown(), { body });
  }

  /** Annulation abandonnée : messages rétablis. */
  async revertClear(sessionID: string): Promise<void> {
    await this.#http.request('DELETE', `/api/session/${seg(sessionID)}/revert`, z.unknown());
  }

  async agents(directory: string): Promise<z.output<typeof AgentList>['data']> {
    return (await this.#http.get('/api/agent', AgentList, { 'location[directory]': directory })).data;
  }

  async models(directory: string): Promise<z.output<typeof ModelList>['data']> {
    return (await this.#http.get('/api/model', ModelList, { 'location[directory]': directory })).data;
  }

  async defaultModel(directory: string): Promise<z.output<typeof ModelDefault>['data']> {
    return (await this.#http.get('/api/model/default', ModelDefault, { 'location[directory]': directory })).data;
  }

  async commands(directory: string): Promise<z.output<typeof CommandList>['data']> {
    return (await this.#http.get('/api/command', CommandList, { 'location[directory]': directory })).data;
  }

  async findFiles(directory: string, q: { query: string; type?: 'file' | 'directory'; limit?: number }, cancellable?: Gio.Cancellable): Promise<z.output<typeof FileFind>['data']> {
    const r = await this.#http.request('GET', '/api/fs/find', FileFind, { query: { 'location[directory]': directory, ...q }, ...(cancellable === undefined ? {} : { cancellable }) });
    return r.data;
  }

  async vcsDiff(directory: string, mode: VcsDiffInput['mode']): Promise<z.output<typeof VcsDiff>['data']> {
    return (await this.#http.get('/api/vcs/diff', VcsDiff, { 'location[directory]': directory, mode })).data;
  }

  /** Messages, plus récents d'abord par défaut ; `cursor` : page plus ancienne. */
  async messages(input: MessageListInput): Promise<Page<MessageV2>> {
    const { sessionID, ...rest } = input;
    // le curseur porte déjà l'ordre (le serveur refuse les deux ensemble)
    const r = await this.#http.get(`/api/session/${seg(sessionID)}/message`, Messages, query<Omit<MessageListInput, 'sessionID'>>(rest.cursor === undefined ? { order: 'desc', ...rest } : rest));
    return { items: r.data, next: r.cursor.next ?? null };
  }
}

/**
 * Événements en direct (`GET /api/event`) : chaque événement JSON brut est passé à `onEvent`
 * (analysé par le store, #171). Retourne une fonction d'arrêt.
 */
export function listenV2(http: OpencodeClient, onEvent: (json: unknown) => void, onState: (connected: boolean, error?: string) => void): () => void {
  return http.listenRaw(
    '/api/event',
    (raw) => {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return;
      }
      onEvent(json);
    },
    onState,
  );
}

/** Version majeure de l'API du serveur : 2 si `/api/info` répond, sinon 1. */
export async function serverMajor(http: OpencodeClient): Promise<1 | 2> {
  try {
    const info = await new OpencodeV2(http).info();
    return Number(info.version.split('.')[0]) >= 2 ? 2 : 1;
  } catch (e) {
    // v1 : route inconnue (404) ou page HTML de l'interface web (réponse non JSON)
    if (e instanceof HttpError && e.status !== 404) throw e;
    if (e instanceof HttpError || e instanceof SyntaxError || e instanceof z.core.$ZodError) return 1;
    throw e;
  }
}
