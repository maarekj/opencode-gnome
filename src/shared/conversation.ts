// Conversation d'une session OpenCode 2 (#171) : historique paginé, puis mis à jour en direct par
// les événements de la session (étapes de l'agent, blocs de texte et de réflexion, outils).
//
// Chaque élément visible est un « bloc » stable (même objet tant que l'élément existe) dont le
// contenu est un Accessor : un delta de streaming ne met à jour que le widget du bloc concerné,
// sans reconstruire la liste.
import GLib from 'gi://GLib';
import { createState, type Accessor, type Setter } from 'gnim';
import * as z from 'zod/mini';
import { errorMessage } from './errors.ts';
import type { FormV2, PermissionV2 } from './v2/schemas.ts';
import type { SessionEventV2, Store } from './store.ts';
import * as E from './v2/events.ts';
import { HistoryEntry, type AssistantMessage, type ToolContentBlock } from './v2/messages.ts';

export interface ContextUsage {
  /** tokens présents dans le contexte au dernier tour */
  readonly tokens: number;
  readonly providerID: string;
  readonly modelID: string;
  /** niveau de raisonnement du dernier tour */
  readonly variant?: string;
  /** coût cumulé des messages chargés */
  readonly cost: number;
  /** tokens lus depuis le cache du fournisseur au dernier tour */
  readonly cacheRead: number;
}

interface Tokens {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cache: { readonly read: number; readonly write: number };
}

/** Tokens du contexte d'un tour : entrée (y compris cache) + sortie, comme le TUI d'opencode. */
export const contextTokens = (t: Tokens | undefined): number => (t === undefined ? 0 : t.input + t.output + t.reasoning + t.cache.read + t.cache.write);

/** Appel d'outil (état v2 : streaming → running → completed / error). */
export interface ToolCall {
  readonly callID: string;
  readonly name: string;
  readonly status: 'streaming' | 'running' | 'completed' | 'error';
  readonly input: Readonly<Record<string, unknown>>;
  /** sortie textuelle (blocs de texte, fichiers en `[nom]`) */
  readonly output: string;
  readonly error?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly time: { readonly start: number; readonly end?: number };
  /** chemin du fichier visé, relatif au dossier de la session (résumé de la ligne) */
  readonly title?: string;
}

/** Contenu d'un bloc. */
export type Item =
  | { readonly kind: 'user'; readonly id: string; readonly messageID: string; readonly text: string }
  | { readonly kind: 'file'; readonly id: string; readonly messageID: string; readonly mime: string; readonly filename: string; readonly url: string }
  | { readonly kind: 'text'; readonly id: string; readonly messageID: string; readonly text: string }
  | { readonly kind: 'reasoning'; readonly id: string; readonly messageID: string; readonly text: string; readonly time: { readonly start?: number; readonly end?: number } }
  | { readonly kind: 'tool'; readonly id: string; readonly messageID: string; readonly tool: ToolCall }
  | { readonly kind: 'error'; readonly id: string; readonly messageID: string; readonly text: string }
  | { readonly kind: 'shell'; readonly id: string; readonly messageID: string; readonly command: string; readonly status: string; readonly output: string; readonly exit?: number | string }
  | { readonly kind: 'compaction'; readonly id: string; readonly messageID: string; readonly status: string; readonly summary: string }
  | { readonly kind: 'notice'; readonly id: string; readonly messageID: string; readonly text: string }
  | { readonly kind: 'turn'; readonly id: string; readonly messageID: string };

export type BlockKind = Item['kind'];

/** Fin d'un tour de l'agent (pied de bloc) : heure et durée depuis le message utilisateur. */
export interface TurnInfo {
  /** heure du message utilisateur */
  readonly created: number;
  /** fin du tour ; absent tant qu'il est en cours */
  readonly completed?: number;
}

export interface Block {
  readonly id: string;
  readonly kind: BlockKind;
  readonly item: Accessor<Item>;
  /** heure de création du message (en-tête des messages utilisateur) */
  readonly created: number;
  /** premier bloc visible de son message (porte l'heure) */
  first?: boolean;
  /** blocs `turn` : bornes du tour */
  readonly turn?: Accessor<TurnInfo>;
}

interface ItemEntry {
  block: Block;
  set: Setter<Item>;
  value: Item;
  dirty: boolean;
}

/** Message (entrée de l'historique) : ses éléments, dans l'ordre. */
interface Message {
  readonly id: string;
  type: string;
  created: number;
  completed?: number;
  /** réponse de l'agent : modèle, jetons, coût */
  assistant?: { agent: string; providerID: string; modelID: string; variant?: string; tokens?: Tokens; cost?: number };
  readonly items: string[];
}

interface TurnEntry {
  readonly block: Block;
  readonly set: Setter<TurnInfo>;
  value: TurnInfo;
}

/** Délai de regroupement des mises à jour (ms) : le streaming émet des dizaines de deltas par seconde. */
const FLUSH_MS = 80;
/**
 * Entrées chargées à l'ouverture (et au rechargement) : peu, pour une ouverture rapide (#141) ;
 * une entrée est une étape de l'agent (texte, réflexion, appels d'outils), souvent plusieurs blocs.
 */
const INITIAL_PAGE = 20;
/** entrées chargées à chaque « messages précédents » */
const PAGE = 100;
/** rechargement après reconnexion : large, pour couvrir ce qui est arrivé pendant la coupure */
const RELOAD_PAGE = 200;
const TIMING = GLib.getenv('OPENCODE_GNOME_TIMING') !== null;

/** Appel d'outil à l'origine d'une demande (permission, question de l'agent), si connu. */
export function requestCall(r: PermissionV2 | FormV2): string | undefined {
  if ('action' in r) return r.source?.id;
  const tool: unknown = r.metadata?.['tool'];
  const id: unknown = typeof tool === 'object' && tool !== null ? Reflect.get(tool, 'id') : undefined;
  return typeof id === 'string' ? id : undefined;
}

/** Retire les repères « [Image N] » insérés par le TUI à la place des images collées. */
export const stripImageMarkers = (text: string): string => text.replaceAll(/\[Image \d+\] ?/gu, '');

/** Élément visible ? (réflexion vide, texte réduit aux repères d'images : non) */
function visible(item: Item): boolean {
  if (item.kind === 'user') return stripImageMarkers(item.text).trim() !== '';
  if (item.kind === 'reasoning' || item.kind === 'text') return item.text.trim() !== '';
  return true;
}

const textItemID = (messageID: string, kind: 'text' | 'reasoning', n: number): string => `${messageID}:${kind}:${n}`;
const toolItemID = (messageID: string, callID: string): string => `${messageID}:tool:${callID}`;

type ToolContentList = z.output<typeof E.ToolContent>[];
const toolOutput = (content: ToolContentList | undefined): string => (content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.name ?? c.uri}]`)).join('\n');

function toolFromHistory(t: ToolContentBlock): ToolCall {
  const s = t.state;
  const time = { start: t.time.ran ?? t.time.created, ...(t.time.completed === undefined ? {} : { end: t.time.completed }) };
  const base = { callID: t.id, name: t.name, time };
  if (s.status === 'streaming') return { ...base, status: 'streaming', input: {}, output: '', metadata: {} };
  if (s.status === 'running') return { ...base, status: 'running', input: s.input, output: '', metadata: s.metadata };
  if (s.status === 'completed') return { ...base, status: 'completed', input: s.input, output: toolOutput(s.content), metadata: s.metadata ?? {} };
  return { ...base, status: 'error', input: s.input, output: toolOutput(s.content), error: s.error.message, metadata: s.metadata ?? {} };
}

/** Appel d'outil visé par un événement. */
const ToolRef = z.object({ assistantMessageID: z.string(), id: z.string() });

const parse = <S extends z.ZodMiniType>(s: S, data: unknown): z.output<S> | null => {
  const r = s.safeParse(data);
  return r.success ? r.data : null;
};

export class Conversation {
  readonly sessionID: string;
  readonly blocks: Accessor<readonly Block[]>;
  readonly loading: Accessor<boolean>;
  readonly error: Accessor<string | null>;
  /** Demandes en attente d'une réponse de l'utilisateur pour cette session. */
  readonly permissions: Accessor<readonly PermissionV2[]>;
  readonly questions: Accessor<readonly FormV2[]>;
  /** Contexte utilisé par la session (dernière réponse de l'agent ayant des tokens). */
  readonly context: Accessor<ContextUsage | null>;
  /** Incrémenté quand la session modifie des fichiers (outils d'édition, shell terminés). */
  readonly diffVersion: Accessor<number>;
  /** des messages plus anciens restent à charger (`loadOlder`) */
  readonly hasOlder: Accessor<boolean>;
  readonly loadingOlder: Accessor<boolean>;

  readonly #store: Store;
  readonly #setBlocks: Setter<readonly Block[]>;
  readonly #setLoading: Setter<boolean>;
  readonly #setError: Setter<string | null>;
  readonly #setPermissions: Setter<readonly PermissionV2[]>;
  readonly #setQuestions: Setter<readonly FormV2[]>;
  readonly #setDiffVersion: Setter<number>;
  readonly #setContext: Setter<ContextUsage | null>;
  readonly #setHasOlder: Setter<boolean>;
  readonly #setLoadingOlder: Setter<boolean>;
  /** curseur des entrées plus anciennes que celles chargées ; null : début de la session atteint */
  #older: string | null = null;
  /** au moins une page ancienne chargée : un rechargement ne touche plus au curseur */
  #olderLoaded = false;
  #directory: string | null = null;
  readonly #messages = new Map<string, Message>();
  readonly #items = new Map<string, ItemEntry>();
  /** message utilisateur -> bloc de fin de tour */
  readonly #turns = new Map<string, TurnEntry>();
  /** messages utilisateur en file d'attente : texte connu à l'envoi, affiché à la remise */
  readonly #inbox = new Map<string, string>();
  #structureChanged = false;
  #contextDirty = false;
  #flushQueued = false;
  #reloadQueued = 0;
  #signature = '';
  #unsubscribe: (() => void) | null = null;
  #unreconnect: (() => void) | null = null;
  #requestsGeneration = 0;
  #disposed = false;
  /** premier message annulé (masqué avec les suivants) */
  #revert: string | null = null;

  constructor(store: Store, sessionID: string) {
    this.#store = store;
    this.sessionID = sessionID;
    [this.blocks, this.#setBlocks] = createState<readonly Block[]>([]);
    [this.loading, this.#setLoading] = createState(true);
    [this.error, this.#setError] = createState<string | null>(null);
    [this.permissions, this.#setPermissions] = createState<readonly PermissionV2[]>([]);
    [this.questions, this.#setQuestions] = createState<readonly FormV2[]>([]);
    [this.diffVersion, this.#setDiffVersion] = createState(0);
    [this.hasOlder, this.#setHasOlder] = createState(false);
    [this.loadingOlder, this.#setLoadingOlder] = createState(false);
    [this.context, this.#setContext] = createState<ContextUsage | null>(null, {
      equals: (a, b) => a?.tokens === b?.tokens && a?.modelID === b?.modelID && a?.variant === b?.variant && a?.cost === b?.cost && a?.cacheRead === b?.cacheRead,
    });
  }

  /** Répertoire de la session (requis par les appels qui ciblent un dossier). */
  get directory(): string | null {
    return this.#directory ?? this.#store.session(this.sessionID)?.directory ?? this.#store.children.peek().get(this.sessionID)?.session.directory ?? null;
  }

  /** Recharge les permissions et questions en attente de cette session. */
  async reloadRequests(): Promise<void> {
    const dir = this.directory;
    if (dir === null) return;
    // relancé à chaque événement de demande : seule la réponse la plus récente compte (#92)
    const gen = ++this.#requestsGeneration;
    try {
      const [permissions, questions] = await Promise.all([this.#store.client.permissions(dir), this.#store.client.questions(dir)]);
      if (this.#disposed || gen !== this.#requestsGeneration) return;
      this.#setPermissions(permissions.filter((p) => p.sessionID === this.sessionID));
      this.#setQuestions(questions.filter((q) => q.sessionID === this.sessionID));
    } catch {
      // affiché à la prochaine action
    }
  }

  /** Charge l'historique et suit les événements. Les événements reçus pendant le chargement sont conservés. */
  async start(): Promise<void> {
    this.#unsubscribe ??= this.#store.onSessionEventsV2(this.sessionID, (e) => this.#apply(e));
    // flux reconnecté : les événements de la coupure sont perdus, tout est relu (#60)
    this.#unreconnect ??= this.#store.onReconnect(() => {
      void Promise.all([this.reload(), this.reloadRequests()]);
    });
    // sous-agent pas encore connu du store : dossier lu sur sa session
    if (this.directory === null) {
      try {
        this.#directory = (await this.#store.client.session(this.sessionID)).directory;
      } catch {
        // affiché par le chargement
      }
    }
    await Promise.all([this.reload(), this.reloadRequests()]);
  }

  async reload(): Promise<void> {
    this.#setLoading(true);
    const t0 = Date.now();
    let count = 0;
    try {
      const limit = this.#messages.size === 0 ? INITIAL_PAGE : RELOAD_PAGE;
      const page = await this.#store.client.v2.messages({ sessionID: this.sessionID, limit });
      count = page.items.length;
      if (this.#disposed) return;
      this.#ingest(page.items);
      if (!this.#olderLoaded) {
        this.#older = page.items.length < limit ? null : page.next;
        this.#setHasOlder(this.#older !== null);
      }
      this.#setError(null);
    } catch (e) {
      this.#setError(errorMessage(e));
    }
    const t1 = Date.now();
    this.#setLoading(false);
    // affichage des blocs (construits de façon synchrone par les abonnés)
    this.#flush();
    if (TIMING) console.log(`TIMING chargement messages=${count} réseau=${t1 - t0} ms affichage=${Date.now() - t1} ms`);
  }

  /**
   * Actualiser : la conversation est relue comme à son ouverture (dernière page seulement, les
   * pages précédentes déjà chargées sont libérées), avec ses demandes.
   */
  async refresh(): Promise<void> {
    if (this.#disposed) return;
    this.#messages.clear();
    this.#items.clear();
    this.#turns.clear();
    this.#older = null;
    this.#olderLoaded = false;
    this.#setHasOlder(false);
    // blocs retirés d'abord : les widgets (liés aux anciens états) sont libérés, puis reconstruits
    this.#structureChanged = true;
    this.#flush();
    await Promise.all([this.reload(), this.reloadRequests()]);
  }

  /** Charge la page d'entrées précédant les plus anciennes déjà chargées. */
  async loadOlder(): Promise<void> {
    const cursor = this.#older;
    if (cursor === null || this.loadingOlder.peek()) return;
    this.#setLoadingOlder(true);
    try {
      const page = await this.#store.client.v2.messages({ sessionID: this.sessionID, limit: PAGE, cursor });
      if (this.#disposed) return;
      this.#olderLoaded = true;
      // page vide : le serveur peut annoncer une suite qui n'existe pas
      this.#older = page.items.length === 0 ? null : page.next;
      this.#ingest(page.items);
      this.#setHasOlder(this.#older !== null);
      this.#flush();
    } catch (e) {
      this.#setError(errorMessage(e));
    } finally {
      this.#setLoadingOlder(false);
    }
  }

  /** Entrées de l'historique (instantané HTTP, peut-être en retard sur le direct). */
  #ingest(entries: readonly unknown[]): void {
    for (const raw of entries) {
      const e = parse(HistoryEntry, raw);
      if (e === null) continue;
      const m = this.#message(e.id, e.type, e.time.created);
      switch (e.type) {
        case 'user': {
          if (!('text' in e) || typeof e.text !== 'string') break;
          this.#setItem(m, { kind: 'user', id: `${e.id}:user`, messageID: e.id, text: e.text }, true);
          const files = 'files' in e && Array.isArray(e.files) ? e.files : [];
          for (const [n, f] of files.entries()) {
            this.#setItem(m, { kind: 'file', id: `${e.id}:file:${n}`, messageID: e.id, mime: f.mime, filename: f.name ?? '', url: `data:${f.mime};base64,${f.data}` }, true);
          }
          break;
        }
        case 'assistant':
          if ('content' in e) this.#ingestAssistant(m, e);
          break;
        case 'shell':
          if ('command' in e)
            this.#setItem(m, { kind: 'shell', id: `${e.id}:shell`, messageID: e.id, command: e.command, status: e.status, output: e.output?.output ?? '', ...(e.exit === undefined ? {} : { exit: e.exit }) }, true);
          break;
        case 'compaction':
          if ('status' in e) this.#setItem(m, { kind: 'compaction', id: `${e.id}:compaction`, messageID: e.id, status: e.status, summary: 'summary' in e ? (e.summary ?? '') : '' }, true);
          break;
        case 'skill':
          if ('name' in e) this.#setItem(m, { kind: 'notice', id: `${e.id}:notice`, messageID: e.id, text: `Skill « ${e.name} » chargée` }, true);
          break;
        case 'agent-switched':
          if ('agent' in e) this.#setItem(m, { kind: 'notice', id: `${e.id}:notice`, messageID: e.id, text: `Agent : ${e.agent}` }, true);
          break;
        case 'model-switched':
          if ('model' in e && typeof e.model === 'object') this.#setItem(m, { kind: 'notice', id: `${e.id}:notice`, messageID: e.id, text: `Modèle : ${e.model.providerID}/${e.model.id}` }, true);
          break;
        case 'idle':
          if ('outcome' in e && e.outcome === 'failed' && e.error !== undefined) this.#setItem(m, { kind: 'error', id: `${e.id}:error`, messageID: e.id, text: e.error.message }, true);
          break;
        default:
          // synthetic, system (contexte injecté pour le modèle), location-switched… : non affichés
          break;
      }
    }
  }

  #ingestAssistant(m: Message, e: AssistantMessage): void {
    if (e.time.completed !== undefined) m.completed = e.time.completed;
    m.assistant = {
      agent: e.agent,
      providerID: e.model.providerID,
      modelID: e.model.id,
      ...(e.model.variant === undefined ? {} : { variant: e.model.variant }),
      ...(e.tokens === undefined ? {} : { tokens: e.tokens }),
      ...(e.cost === undefined ? {} : { cost: e.cost }),
    };
    this.#contextDirty = true;
    const count = { text: 0, reasoning: 0 };
    for (const c of e.content) {
      if (c.type === 'tool') {
        this.#setItem(m, { kind: 'tool', id: toolItemID(e.id, c.id), messageID: e.id, tool: toolFromHistory(c) }, true);
        continue;
      }
      const n = count[c.type]++;
      const time = c.type === 'reasoning' ? { ...(c.time === undefined ? {} : { start: c.time.created }), ...(c.time?.completed === undefined ? {} : { end: c.time.completed }) } : {};
      this.#setItem(m, c.type === 'text' ? { kind: 'text', id: textItemID(e.id, 'text', n), messageID: e.id, text: c.text } : { kind: 'reasoning', id: textItemID(e.id, 'reasoning', n), messageID: e.id, text: c.text, time }, true);
    }
    if (e.error !== undefined) this.#setItem(m, { kind: 'error', id: `${e.id}:error`, messageID: e.id, text: e.error.message }, true);
  }

  /** Masque les messages annulés à partir de `messageID` ; null : tout afficher. */
  setRevert(messageID: string | null): void {
    if (messageID === this.#revert) return;
    this.#revert = messageID;
    this.#structureChanged = true;
    this.#flush();
  }

  /** Messages de l'utilisateur chargés, du plus ancien au plus récent, avec leur texte. */
  userMessages(): { id: string; text: string }[] {
    const out: { id: string; text: string }[] = [];
    for (const m of this.#sorted()) {
      if (m.type !== 'user') continue;
      const item = this.#items.get(`${m.id}:user`)?.value;
      out.push({ id: m.id, text: item?.kind === 'user' ? stripImageMarkers(item.text).trim() : '' });
    }
    return out;
  }

  dispose(): void {
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#unreconnect?.();
    this.#unreconnect = null;
  }

  /** Événement v2 de la session. */
  #apply({ type, created, data }: SessionEventV2): void {
    switch (type) {
      case 'permission.asked':
      case 'permission.replied':
      case 'form.created':
      case 'form.replied':
      case 'form.cancelled':
        void this.reloadRequests();
        return;
      case 'session.inbox.enqueued': {
        const d = parse(E.InboxEnqueued, data);
        const user = d?.item.type === 'user' ? parse(E.UserPayload, d.item.payload) : null;
        if (d !== null && user !== null) this.#inbox.set(d.inboxID, user.text);
        return;
      }
      case 'session.inbox.delivered': {
        const d = parse(E.InboxDelivered, data);
        if (d === null) return;
        const text = this.#inbox.get(d.inboxID);
        this.#inbox.delete(d.inboxID);
        // envoyé par un autre client (texte inconnu) : relu
        if (text === undefined) {
          this.#reloadSoon();
          return;
        }
        const m = this.#message(d.inboxID, 'user', created);
        this.#setItem(m, { kind: 'user', id: `${d.inboxID}:user`, messageID: d.inboxID, text });
        break;
      }
      case 'session.step.started': {
        const d = parse(E.StepStarted, data);
        if (d === null) return;
        const m = this.#message(d.assistantMessageID, 'assistant', d.started);
        m.assistant = { agent: d.agent, providerID: d.model.providerID, modelID: d.model.id, ...(d.model.variant === undefined ? {} : { variant: d.model.variant }) };
        break;
      }
      case 'session.step.ended':
      case 'session.step.failed': {
        const d = parse(type === 'session.step.ended' ? E.StepEnded : E.StepFailed, data);
        if (d === null) return;
        const m = this.#message(d.assistantMessageID, 'assistant', created);
        m.completed = created;
        if (m.assistant !== undefined) {
          if (d.tokens !== undefined) m.assistant.tokens = d.tokens;
          if (d.cost !== undefined) m.assistant.cost = d.cost;
        }
        this.#contextDirty = true;
        const failed = parse(E.StepFailed, data);
        if (type === 'session.step.failed' && failed !== null) this.#setItem(m, { kind: 'error', id: `${m.id}:error`, messageID: m.id, text: failed.error.message });
        break;
      }
      case 'session.text.started':
      case 'session.reasoning.started':
      case 'session.text.delta':
      case 'session.reasoning.delta':
      case 'session.text.ended':
      case 'session.reasoning.ended':
        this.#applyBlock(type, created, data);
        break;
      case 'session.tool.input.started':
      case 'session.tool.called':
      case 'session.tool.progress':
      case 'session.tool.success':
      case 'session.tool.failed':
        this.#applyTool(type, created, data);
        break;
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted': {
        // fin du tour : entrée « idle » locale (l'historique a la sienne)
        const m = this.#message(`~idle:${created}`, 'idle', created);
        const failed = type === 'session.execution.failed' ? parse(E.ExecutionFailed, data) : null;
        if (failed !== null) this.#setItem(m, { kind: 'error', id: `${m.id}:error`, messageID: m.id, text: failed.error.message });
        this.#structureChanged = true;
        break;
      }
      case 'session.shell.started':
      case 'session.shell.ended':
      case 'session.compaction.started':
      case 'session.compaction.ended':
      case 'session.compaction.failed':
      case 'session.synthetic':
      case 'session.skill.activated':
      case 'session.agent.selected':
      case 'session.model.selected':
      case 'session.message.content.updated':
        // entrées rares : relues depuis l'historique
        this.#reloadSoon();
        return;
      default:
        return;
    }
    this.#scheduleFlush();
  }

  #applyBlock(type: string, created: number, data: unknown): void {
    const kind = type.startsWith('session.text.') ? 'text' : 'reasoning';
    const d = parse(E.Block, data);
    if (d === null) return;
    const m = this.#message(d.assistantMessageID, 'assistant', created);
    const id = textItemID(d.assistantMessageID, kind, d.ordinal);
    const before = this.#items.get(id)?.value;
    const prev = before?.kind === kind ? before.text : '';
    const start = before?.kind === 'reasoning' ? before.time.start : created;
    let text = prev;
    let end: number | undefined;
    if (type.endsWith('.delta')) text = prev + (parse(E.BlockDelta, data)?.delta ?? '');
    else if (type.endsWith('.ended')) {
      text = parse(E.BlockEnded, data)?.text ?? prev;
      end = created;
    }
    this.#setItem(
      m,
      kind === 'text'
        ? { kind: 'text', id, messageID: m.id, text }
        : { kind: 'reasoning', id, messageID: m.id, text, time: { ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) } },
    );
  }

  #applyTool(type: string, created: number, data: unknown): void {
    const ref = parse(ToolRef, data);
    if (ref === null) return;
    const m = this.#message(ref.assistantMessageID, 'assistant', created);
    const id = toolItemID(ref.assistantMessageID, ref.id);
    const before = this.#items.get(id)?.value;
    const prev: ToolCall = before?.kind === 'tool' ? before.tool : { callID: ref.id, name: '', status: 'streaming', input: {}, output: '', metadata: {}, time: { start: created } };
    let next: ToolCall = prev;
    switch (type) {
      case 'session.tool.input.started': {
        const d = parse(E.ToolStarted, data);
        if (d !== null) next = { ...prev, name: d.name };
        break;
      }
      case 'session.tool.called': {
        const d = parse(E.ToolCalled, data);
        if (d !== null) next = { ...prev, status: 'running', input: d.input, time: { start: created } };
        break;
      }
      case 'session.tool.progress': {
        const d = parse(E.ToolProgress, data);
        if (d !== null) next = { ...prev, metadata: d.metadata };
        break;
      }
      case 'session.tool.success': {
        const d = parse(E.ToolSuccess, data);
        if (d !== null) next = { ...prev, status: 'completed', output: toolOutput(d.content), metadata: d.metadata ?? prev.metadata, time: { ...prev.time, end: created } };
        // fichiers peut-être modifiés : fenêtre des modifications à rafraîchir
        if (['edit', 'write', 'shell', 'patch'].includes(prev.name)) this.#setDiffVersion(this.diffVersion.peek() + 1);
        break;
      }
      default: {
        const d = parse(E.ToolFailed, data);
        if (d !== null) next = { ...prev, status: 'error', error: d.error.message, output: toolOutput(d.content), metadata: d.metadata ?? prev.metadata, time: { ...prev.time, end: created } };
      }
    }
    this.#setItem(m, { kind: 'tool', id, messageID: m.id, tool: next });
  }

  /** Relecture groupée de la dernière page (entrées rares reçues en direct). */
  #reloadSoon(): void {
    if (this.#reloadQueued !== 0) return;
    this.#reloadQueued = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
      this.#reloadQueued = 0;
      if (!this.#disposed) void this.reload();
      return GLib.SOURCE_REMOVE;
    });
  }

  /** Message connu, ou créé (heure : la plus ancienne connue). */
  #message(id: string, type: string, created: number): Message {
    let m = this.#messages.get(id);
    if (m === undefined) {
      m = { id, type, created, items: [] };
      this.#messages.set(id, m);
      this.#structureChanged = true;
    } else if (m.type !== type || (created < m.created && created > 0)) {
      m.type = type;
      m.created = Math.min(m.created, created);
      this.#structureChanged = true;
    }
    return m;
  }

  /**
   * Crée ou met à jour un élément. `snapshot` : lu par HTTP, peut-être plus ancien que le direct :
   * un texte local plus long qui prolonge celui de l'instantané est gardé (#72).
   */
  #setItem(m: Message, input: Item, snapshot = false): void {
    const item = input.kind === 'tool' ? { ...input, tool: this.#titled(input.tool) } : input;
    const entry = this.#items.get(item.id);
    if (entry !== undefined) {
      const live = entry.value;
      if (snapshot && (live.kind === 'text' || live.kind === 'reasoning') && item.kind === live.kind && live.text.length > item.text.length && live.text.startsWith(item.text)) return;
      if (visible(entry.value) !== visible(item)) this.#structureChanged = true;
      entry.value = item;
      entry.dirty = true;
      return;
    }
    const [accessor, set] = createState<Item>(item);
    this.#items.set(item.id, { block: { id: item.id, kind: item.kind, item: accessor, created: m.created }, set, value: item, dirty: false });
    if (!m.items.includes(item.id)) m.items.push(item.id);
    this.#structureChanged = true;
  }

  /** Titre d'un appel : chemin visé (`path`) relatif au dossier de la session. */
  #titled(t: ToolCall): ToolCall {
    const p = t.input['path'];
    const dir = this.directory;
    if (typeof p !== 'string' || dir === null || !p.startsWith(`${dir}/`)) return t;
    return { ...t, title: p.slice(dir.length + 1) };
  }

  #sorted(): Message[] {
    return [...this.#messages.values()].toSorted((a, b) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Contexte : dernière réponse de l'agent qui a des tokens ; coût cumulé. */
  #updateContext(): void {
    let last: Message | null = null;
    let cost = 0;
    for (const m of this.#sorted()) {
      cost += m.assistant?.cost ?? 0;
      if (contextTokens(m.assistant?.tokens) > 0) last = m;
    }
    const a = last?.assistant;
    if (a === undefined) return;
    this.#setContext({ tokens: contextTokens(a.tokens), providerID: a.providerID, modelID: a.modelID, ...(a.variant === undefined ? {} : { variant: a.variant }), cost, cacheRead: a.tokens?.cache.read ?? 0 });
  }

  #scheduleFlush(): void {
    if (this.#flushQueued) return;
    this.#flushQueued = true;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, FLUSH_MS, () => {
      this.#flushQueued = false;
      if (!this.#disposed) this.#flush();
      return GLib.SOURCE_REMOVE;
    });
  }

  #flush(): void {
    if (this.#contextDirty) {
      this.#contextDirty = false;
      this.#updateContext();
    }
    for (const entry of this.#items.values()) {
      if (entry.dirty) {
        entry.dirty = false;
        entry.set(entry.value);
      }
    }
    const revert = this.#revert;
    const messages = this.#sorted().filter((m) => revert === null || m.id < revert || m.id.startsWith('~'));
    this.#updateTurns(messages);
    if (!this.#structureChanged) return;
    this.#structureChanged = false;
    const blocks: Block[] = [];
    // tour : d'un message utilisateur au suivant ; son pied de tour avant le message suivant
    let turn: string | null = null;
    const closeTurn = (): void => {
      const t = turn === null ? undefined : this.#turns.get(turn);
      if (t !== undefined) blocks.push(t.block);
    };
    for (const m of messages) {
      if (m.type === 'user') {
        closeTurn();
        turn = m.id;
      }
      let first = true;
      for (const id of m.items) {
        const entry = this.#items.get(id);
        if (entry === undefined || !visible(entry.value)) continue;
        // heure du message changée (message créé par un événement, puis lu) : nouveau bloc
        if (entry.block.created !== m.created) {
          const [accessor, set] = createState<Item>(entry.value);
          entry.block = { id, kind: entry.value.kind, item: accessor, created: m.created };
          entry.set = set;
        }
        entry.block.first = first;
        first = false;
        blocks.push(entry.block);
      }
    }
    closeTurn();
    const signature = blocks.map((b) => `${b.id}:${b.kind}:${b.first === true ? 1 : 0}`).join(',');
    if (signature === this.#signature) return;
    this.#signature = signature;
    this.#setBlocks(blocks);
  }

  /** Bornes de chaque tour : message utilisateur -> première fin d'exécution (`idle`) qui suit. */
  #updateTurns(messages: readonly Message[]): void {
    let user: Message | null = null;
    const ends = new Map<string, number | undefined>();
    for (const m of messages) {
      if (m.type === 'user') {
        user = m;
        ends.set(m.id, undefined);
      } else if (user !== null && m.type === 'idle' && ends.get(user.id) === undefined) ends.set(user.id, m.created);
    }
    for (const [userID, end] of ends) {
      const created = this.#messages.get(userID)?.created ?? 0;
      const value: TurnInfo = end === undefined ? { created } : { created, completed: end };
      const entry = this.#turns.get(userID);
      if (entry === undefined) {
        const [accessor, set] = createState<TurnInfo>(value);
        const [item] = createState<Item>({ kind: 'turn', id: `${userID}:turn`, messageID: userID });
        this.#turns.set(userID, { block: { id: `${userID}:turn`, kind: 'turn', item, created, turn: accessor }, set, value });
        this.#structureChanged = true;
      } else if (entry.value.completed !== value.completed || entry.value.created !== value.created) {
        entry.value = value;
        entry.set(value);
      }
    }
  }
}
