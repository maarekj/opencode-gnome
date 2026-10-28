// Conversation d'une session : messages chargés puis mis à jour en direct (streaming des parties).
//
// Chaque partie visible est un « bloc » stable (même objet tant que la partie existe) dont le contenu
// est un Accessor : un delta de streaming ne met à jour que le widget du bloc concerné, sans
// reconstruire la liste.
import GLib from 'gi://GLib';
import { createState, type Accessor, type Setter } from 'gnim';
import { errorMessage } from './errors.ts';
import type { MessageInfo, MessageWithParts, Part, PermissionRequest, QuestionRequest, SessionEvent, Todo } from './schemas.ts';
import type { Store } from './store.ts';

export interface ContextUsage {
  /** tokens présents dans le contexte au dernier tour */
  readonly tokens: number;
  readonly providerID: string;
  readonly modelID: string;
  /** niveau de raisonnement du dernier tour */
  readonly variant?: string;
  /** coût cumulé des messages chargés */
  readonly cost: number;
}

/** Tokens du contexte d'un tour : entrée (y compris cache) + sortie, comme le TUI d'opencode. */
export const contextTokens = (info: MessageInfo): number => {
  const t = info.tokens;
  if (t === undefined) return 0;
  return t.input + t.output + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
};

export type BlockKind = 'user' | 'text' | 'reasoning' | 'tool' | 'file' | 'error' | 'turn';

/** Fin d'un tour de l'agent (pied de bloc) : heure et durée depuis le message utilisateur. */
export interface TurnInfo {
  /** heure du message utilisateur */
  readonly created: number;
  /** fin du dernier message de l'agent ; absent tant que le tour est en cours */
  readonly completed?: number;
}

export interface Block {
  readonly id: string;
  readonly kind: BlockKind;
  readonly part: Accessor<Part>;
  /** heure de création du message (en-tête des messages utilisateur) */
  readonly created: number;
  /** premier bloc visible de son message (porte l'heure) */
  first?: boolean;
  /** blocs `turn` : bornes du tour */
  readonly turn?: Accessor<TurnInfo>;
}

interface TurnEntry {
  readonly block: Block;
  readonly set: Setter<TurnInfo>;
  value: TurnInfo;
}

interface PartEntry {
  readonly block: Block;
  readonly set: Setter<Part>;
  value: Part;
  dirty: boolean;
}

interface MessageEntry {
  info: MessageInfo;
  readonly parts: string[];
}

/** Délai de regroupement des mises à jour (ms) : le streaming émet des dizaines de deltas par seconde. */
const FLUSH_MS = 80;
/**
 * Messages chargés à l'ouverture (et au rechargement) : peu, pour une ouverture rapide (#141) ; un
 * message est une étape de l'agent (texte, réflexion, appels d'outils), souvent plusieurs blocs.
 */
const INITIAL_PAGE = 20;
/** messages chargés à chaque « messages précédents » (en remontant en haut, ou par le bouton) */
const PAGE = 100;
/** rechargement après reconnexion : large, pour couvrir les messages arrivés pendant la coupure */
const RELOAD_PAGE = 200;
const TIMING = GLib.getenv('OPENCODE_GNOME_TIMING') !== null;

/** Retire les repères « [Image N] » insérés par le TUI à la place des images collées. */
export const stripImageMarkers = (text: string): string => text.replaceAll(/\[Image \d+\] ?/gu, '');

function kindOf(role: string, part: Part): BlockKind | null {
  switch (part.type) {
    case 'text':
      if (part.synthetic === true || part.ignored === true) return null;
      if (role !== 'user') return 'text';
      // texte réduit aux repères « [Image N] » du TUI : les miniatures suffisent
      return stripImageMarkers(part.text ?? '').trim() === '' ? null : 'user';
    case 'reasoning':
      return (part.text ?? '').trim() === '' ? null : 'reasoning';
    case 'tool':
      return 'tool';
    case 'file':
      return 'file';
    default:
      return null; // step-start, step-finish, snapshot, patch, agent…
  }
}

const errorPart = (info: MessageInfo): Part | null =>
  info.error === undefined
    ? null
    : { id: `${info.id}-error`, type: 'error', messageID: info.id, sessionID: info.sessionID, text: `${info.error.name ?? 'Erreur'} : ${info.error.data?.message ?? ''}` };

export class Conversation {
  readonly sessionID: string;
  readonly blocks: Accessor<readonly Block[]>;
  readonly loading: Accessor<boolean>;
  readonly error: Accessor<string | null>;
  /** Demandes en attente d'une réponse de l'utilisateur pour cette session. */
  readonly permissions: Accessor<readonly PermissionRequest[]>;
  readonly questions: Accessor<readonly QuestionRequest[]>;
  /** Contexte utilisé par la session (dernier message de l'assistant ayant des tokens). */
  readonly context: Accessor<ContextUsage | null>;
  /** Incrémenté quand la session modifie des fichiers (`session.diff`, outils d'édition terminés). */
  readonly diffVersion: Accessor<number>;
  /** Liste de tâches de la session (remplacée en entier à chaque `todo.updated`). */
  readonly todos: Accessor<readonly Todo[]>;
  /** des messages plus anciens restent à charger (`loadOlder`) */
  readonly hasOlder: Accessor<boolean>;
  readonly loadingOlder: Accessor<boolean>;

  readonly #store: Store;
  readonly #setTodos: Setter<readonly Todo[]>;
  readonly #setBlocks: Setter<readonly Block[]>;
  readonly #setLoading: Setter<boolean>;
  readonly #setError: Setter<string | null>;
  readonly #setPermissions: Setter<readonly PermissionRequest[]>;
  readonly #setQuestions: Setter<readonly QuestionRequest[]>;
  readonly #setDiffVersion: Setter<number>;
  readonly #setContext: Setter<ContextUsage | null>;
  readonly #setHasOlder: Setter<boolean>;
  readonly #setLoadingOlder: Setter<boolean>;
  /** curseur des messages plus anciens que ceux chargés ; null : début de la session atteint */
  #older: string | null = null;
  /** au moins une page ancienne chargée : un rechargement ne touche plus au curseur */
  #olderLoaded = false;
  #directory: string | null = null;
  readonly #messages = new Map<string, MessageEntry>();
  readonly #parts = new Map<string, PartEntry>();
  /** message utilisateur -> bloc de fin de tour */
  readonly #turns = new Map<string, TurnEntry>();
  #structureChanged = false;
  #contextDirty = false;
  #flushQueued = false;
  #signature = '';
  #unsubscribe: (() => void) | null = null;
  #unreconnect: (() => void) | null = null;
  #requestsGeneration = 0;
  /** chargements de l'historique en cours */
  #reloading = 0;
  /** deltas reçus pendant un chargement pour des parties encore inconnues */
  readonly #early = new Map<string, { field: string; delta: string }[]>();
  #disposed = false;
  /** premier message annulé (masqué avec les suivants) */
  #revert: string | null = null;

  constructor(store: Store, sessionID: string) {
    this.#store = store;
    this.sessionID = sessionID;
    [this.blocks, this.#setBlocks] = createState<readonly Block[]>([]);
    [this.loading, this.#setLoading] = createState(true);
    [this.error, this.#setError] = createState<string | null>(null);
    [this.permissions, this.#setPermissions] = createState<readonly PermissionRequest[]>([]);
    [this.questions, this.#setQuestions] = createState<readonly QuestionRequest[]>([]);
    [this.diffVersion, this.#setDiffVersion] = createState(0);
    [this.hasOlder, this.#setHasOlder] = createState(false);
    [this.loadingOlder, this.#setLoadingOlder] = createState(false);
    [this.todos, this.#setTodos] = createState<readonly Todo[]>([], { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
    [this.context, this.#setContext] = createState<ContextUsage | null>(null, {
      equals: (a, b) => a?.tokens === b?.tokens && a?.modelID === b?.modelID && a?.variant === b?.variant && a?.cost === b?.cost,
    });
  }

  /** Répertoire de la session (requis par les appels qui ciblent une instance opencode). */
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
    this.#unsubscribe ??= this.#store.onSessionEvents(this.sessionID, (e) => this.#apply(e));
    // flux reconnecté : les événements de la coupure sont perdus, tout est relu (#60)
    this.#unreconnect ??= this.#store.onReconnect(() => {
      void Promise.all([this.reload(), this.reloadRequests(), this.reloadTodos()]);
    });
    // répertoire inconnu avant le chargement (session de sous-agent) : demandes rechargées ensuite
    const known = this.directory !== null;
    await (known ? Promise.all([this.reload(), this.reloadRequests(), this.reloadTodos()]) : this.reload());
    if (!known) await Promise.all([this.reloadRequests(), this.reloadTodos()]);
  }

  async reloadTodos(): Promise<void> {
    const dir = this.directory;
    if (dir === null) return;
    try {
      const todos = await this.#store.client.todos(this.sessionID, dir);
      if (!this.#disposed) this.#setTodos(todos);
    } catch {
      // liste absente : rien à afficher
    }
  }

  async reload(): Promise<void> {
    this.#setLoading(true);
    this.#reloading += 1;
    const t0 = Date.now();
    let count = 0;
    try {
      const limit = this.#messages.size === 0 ? INITIAL_PAGE : RELOAD_PAGE;
      const { messages, older } = await this.#store.client.messagePage(this.sessionID, limit);
      count = messages.length;
      if (this.#disposed) return;
      this.#ingest(messages);
      this.#replayEarly();
      if (!this.#olderLoaded) {
        this.#older = older;
        this.#setHasOlder(older !== null);
      }
      this.#setError(null);
    } catch (e) {
      this.#setError(errorMessage(e));
    } finally {
      this.#reloading -= 1;
      if (this.#reloading === 0) this.#early.clear();
    }
    const t1 = Date.now();
    this.#setLoading(false);
    // affichage des blocs (construits de façon synchrone par les abonnés)
    this.#flush();
    if (TIMING) console.log(`TIMING chargement messages=${count} réseau=${t1 - t0} ms affichage=${Date.now() - t1} ms`);
  }

  /**
   * Deltas reçus pendant le chargement pour des parties encore inconnues : l'instantané en
   * contient une partie (ceux arrivés avant sa création). Le texte de l'instantané se termine
   * par les premiers deltas ; seuls les suivants sont appliqués (#72).
   */
  #replayEarly(): void {
    for (const [partID, deltas] of this.#early) {
      const entry = this.#parts.get(partID);
      if (entry === undefined) continue;
      this.#early.delete(partID);
      const byField = new Map<string, string[]>();
      for (const d of deltas) byField.set(d.field, [...(byField.get(d.field) ?? []), d.delta]);
      for (const [field, list] of byField) {
        const prev = entry.value[field];
        const text = typeof prev === 'string' ? prev : '';
        // plus grand k : le texte se termine par les k premiers deltas
        let skip = 0;
        for (let k = list.length; k > 0; k -= 1) {
          if (text.endsWith(list.slice(0, k).join(''))) {
            skip = k;
            break;
          }
        }
        const rest = list.slice(skip).join('');
        if (rest === '') continue;
        entry.value = { ...entry.value, [field]: text + rest };
        entry.dirty = true;
      }
    }
  }

  /**
   * Actualiser : la conversation est relue comme à son ouverture (dernière page seulement, les
   * pages précédentes déjà chargées sont libérées), avec ses demandes et sa liste de tâches.
   */
  async refresh(): Promise<void> {
    if (this.#disposed) return;
    this.#messages.clear();
    this.#parts.clear();
    this.#turns.clear();
    this.#older = null;
    this.#olderLoaded = false;
    this.#setHasOlder(false);
    // blocs retirés d'abord : les widgets (liés aux anciens états) sont libérés, puis reconstruits
    this.#structureChanged = true;
    this.#flush();
    await Promise.all([this.reload(), this.reloadRequests(), this.reloadTodos()]);
  }

  /** Charge la page de messages précédant les plus anciens déjà chargés. */
  async loadOlder(): Promise<void> {
    const cursor = this.#older;
    if (cursor === null || this.loadingOlder.peek()) return;
    this.#setLoadingOlder(true);
    try {
      const { messages, older } = await this.#store.client.messagePage(this.sessionID, PAGE, cursor);
      if (this.#disposed) return;
      this.#olderLoaded = true;
      this.#older = older;
      this.#ingest(messages);
      this.#setHasOlder(older !== null);
      this.#flush();
    } catch (e) {
      this.#setError(errorMessage(e));
    } finally {
      this.#setLoadingOlder(false);
    }
  }

  #ingest(messages: readonly MessageWithParts[]): void {
    for (const { info, parts } of messages) {
      const path: unknown = info['path'];
      if (this.#directory === null && typeof path === 'object' && path !== null && 'cwd' in path && typeof path.cwd === 'string') this.#directory = path.cwd;
      this.#upsertMessage(info);
      for (const part of parts) this.#upsertPart(part, true);
    }
  }

  /** Masque les messages annulés (`/undo`) à partir de `messageID` ; null : tout afficher. */
  setRevert(messageID: string | null): void {
    if (messageID === this.#revert) return;
    this.#revert = messageID;
    this.#structureChanged = true;
    this.#flush();
  }

  /**
   * Messages de l'utilisateur chargés, du plus ancien au plus récent, avec leur texte
   * (parties `text` non synthétiques, repères « [Image N] » retirés).
   */
  userMessages(): { id: string; text: string }[] {
    const out: { id: string; text: string }[] = [];
    for (const id of [...this.#messages.keys()].toSorted()) {
      const m = this.#messages.get(id);
      if (m?.info.role !== 'user') continue;
      const text = m.parts
        .map((p) => this.#parts.get(p)?.value)
        .filter((p): p is Part => p?.type === 'text' && p.synthetic !== true && p.ignored !== true)
        .map((p) => stripImageMarkers(p.text ?? ''))
        .join('\n')
        .trim();
      out.push({ id, text });
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

  #apply(e: SessionEvent): void {
    switch (e.type) {
      case 'permission.asked':
      case 'permission.v2.asked':
      case 'permission.replied':
      case 'permission.v2.replied':
      case 'question.asked':
      case 'question.v2.asked':
      case 'question.replied':
      case 'question.v2.replied':
      case 'question.rejected':
      case 'question.v2.rejected':
        void this.reloadRequests();
        return;
      case 'session.diff':
        this.#setDiffVersion(this.diffVersion.peek() + 1);
        return;
      case 'todo.updated':
        this.#setTodos(e.properties.todos);
        return;
      case 'message.updated':
        this.#upsertMessage(e.properties.info);
        break;
      case 'message.removed': {
        const m = this.#messages.get(e.properties.messageID);
        for (const id of m?.parts ?? []) this.#parts.delete(id);
        this.#messages.delete(e.properties.messageID);
        this.#structureChanged = true;
        break;
      }
      case 'message.part.updated':
        this.#upsertPart(e.properties.part);
        break;
      case 'message.part.removed': {
        const m = this.#messages.get(e.properties.messageID);
        if (m !== undefined) m.parts.splice(m.parts.indexOf(e.properties.partID) >>> 0, 1);
        this.#parts.delete(e.properties.partID);
        this.#structureChanged = true;
        break;
      }
      case 'message.part.delta': {
        const { partID, field, delta } = e.properties;
        const entry = this.#parts.get(partID);
        if (entry === undefined) {
          // chargement en cours : la partie arrivera avec l'instantané (rejoué ensuite) ;
          // sinon elle arrivera via message.part.updated
          if (this.#reloading > 0) this.#early.set(partID, [...(this.#early.get(partID) ?? []), { field, delta }]);
          return;
        }
        const prev = entry.value[field];
        entry.value = { ...entry.value, [field]: (typeof prev === 'string' ? prev : '') + delta };
        entry.dirty = true;
        break;
      }
      default:
        return;
    }
    this.#scheduleFlush();
  }

  #message(id: string): MessageEntry | undefined {
    return this.#messages.get(id);
  }

  /** Recalcule le contexte depuis le dernier message de l'assistant qui a des tokens. */
  #updateContext(): void {
    let last: MessageInfo | null = null;
    let cost = 0;
    for (const { info } of this.#messages.values()) {
      cost += info.cost ?? 0;
      if (info.role !== 'assistant' || contextTokens(info) === 0) continue;
      if (last === null || info.id > last.id) last = info;
    }
    if (last === null) return;
    this.#setContext({
      tokens: contextTokens(last),
      providerID: last.providerID ?? '',
      modelID: last.modelID ?? '',
      ...(last.variant === undefined ? {} : { variant: last.variant }),
      cost,
    });
  }

  #upsertMessage(info: MessageInfo): void {
    if (info.role === 'assistant') this.#contextDirty = true;
    const m = this.#messages.get(info.id);
    if (m === undefined) {
      this.#messages.set(info.id, { info, parts: [] });
      this.#structureChanged = true;
    } else {
      if ((m.info.error === undefined) !== (info.error === undefined)) this.#structureChanged = true;
      // message provisoire (partie reçue avant lui) : rôle et heure réels connus maintenant (#98)
      // (#pushParts recrée alors les blocs dont le type change)
      if (m.info.role !== info.role || m.info.time.created !== info.time.created) this.#structureChanged = true;
      m.info = info;
    }
    const err = errorPart(info);
    if (err !== null) this.#upsertPart(err);
  }

  /** `snapshot` : partie lue par HTTP, peut-être plus ancienne que les deltas déjà appliqués. */
  #upsertPart(part: Part, snapshot = false): void {
    let m = this.#message(part.messageID);
    if (m === undefined) {
      // partie reçue avant son message : message provisoire
      m = { info: { id: part.messageID, role: 'assistant', sessionID: part.sessionID, time: { created: 0 } }, parts: [] };
      this.#messages.set(part.messageID, m);
    }
    const entry = this.#parts.get(part.id);
    if (entry !== undefined) {
      // texte local plus long qui prolonge celui de l'instantané : l'instantané est en retard (#72)
      const live = entry.value['text'];
      const snap = part['text'];
      if (snapshot && typeof live === 'string' && typeof snap === 'string' && live.length > snap.length && live.startsWith(snap)) return;
      entry.value = part;
      entry.dirty = true;
      // une partie peut devenir visible (reasoning vide -> rempli)
      if (kindOf(m.info.role, part) !== entry.block.kind) this.#structureChanged = true;
      return;
    }
    const kind = part.type === 'error' ? 'error' : kindOf(m.info.role, part);
    const [accessor, set] = createState<Part>(part);
    this.#parts.set(part.id, { block: { id: part.id, kind: kind ?? 'text', part: accessor, created: m.info.time.created }, set, value: part, dirty: false });
    if (!m.parts.includes(part.id)) m.parts.push(part.id);
    this.#structureChanged = true;
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
    for (const entry of this.#parts.values()) {
      if (entry.dirty) {
        entry.dirty = false;
        entry.set(entry.value);
      }
    }
    this.#updateTurns();
    if (!this.#structureChanged) return;
    this.#structureChanged = false;
    const blocks: Block[] = [];
    // les identifiants opencode sont triables chronologiquement ; messages annulés masqués
    const revert = this.#revert;
    const ids = [...this.#messages.keys()].toSorted().filter((id) => revert === null || id < revert);
    // dernier message de l'agent de chaque tour : le pied de tour vient après lui
    const lastOfTurn = new Map<string, string>();
    for (const id of ids) {
      const info = this.#messages.get(id)?.info;
      if (info?.role === 'assistant' && info.parentID !== undefined) lastOfTurn.set(info.parentID, id);
    }
    for (const id of ids) {
      const m = this.#messages.get(id);
      if (m === undefined) continue;
      this.#pushParts(m, blocks);
      const parent = m.info.parentID;
      if (parent !== undefined && lastOfTurn.get(parent) === id) {
        const turn = this.#turns.get(parent);
        if (turn !== undefined) blocks.push(turn.block);
      }
    }
    const signature = blocks.map((b) => `${b.id}:${b.kind}:${b.first === true ? 1 : 0}`).join(',');
    if (signature === this.#signature) return;
    this.#signature = signature;
    this.#setBlocks(blocks);
  }

  /** Bornes de chaque tour (message utilisateur -> fin du dernier message de l'agent). */
  #updateTurns(): void {
    const ends = new Map<string, number | undefined>();
    for (const { info } of this.#messages.values()) {
      if (info.role !== 'assistant' || info.parentID === undefined) continue;
      // un message de l'agent non terminé rend le tour « en cours »
      const prev = ends.has(info.parentID) ? ends.get(info.parentID) : 0;
      ends.set(info.parentID, prev === undefined || info.time.completed === undefined ? undefined : Math.max(prev, info.time.completed));
    }
    for (const [userID, end] of ends) {
      const user = this.#messages.get(userID)?.info;
      if (user === undefined) continue;
      const value: TurnInfo = end === undefined ? { created: user.time.created } : { created: user.time.created, completed: end };
      const entry = this.#turns.get(userID);
      if (entry === undefined) {
        const [accessor, set] = createState<TurnInfo>(value);
        const [part] = createState<Part>({ id: `${userID}-turn`, type: 'turn', messageID: userID, sessionID: this.sessionID });
        this.#turns.set(userID, { block: { id: `${userID}-turn`, kind: 'turn', part, created: user.time.created, turn: accessor }, set, value });
        this.#structureChanged = true;
      } else if (entry.value.completed !== value.completed) {
        entry.value = value;
        entry.set(value);
      }
    }
  }

  #pushParts(m: MessageEntry, blocks: Block[]): void {
    let first = true;
    for (const partID of m.parts) {
      const entry = this.#parts.get(partID);
      if (entry === undefined) continue;
      const kind = entry.value.type === 'error' ? 'error' : kindOf(m.info.role, entry.value);
      if (kind === null) continue;
      // le type visible ou l'heure (message provisoire) peut avoir changé : nouveau bloc
      if (kind !== entry.block.kind || entry.block.created !== m.info.time.created) {
        const [accessor, set] = createState<Part>(entry.value);
        this.#parts.set(partID, { block: { id: partID, kind, part: accessor, created: m.info.time.created }, set, value: entry.value, dirty: false });
      }
      const block = this.#parts.get(partID)?.block ?? entry.block;
      block.first = first;
      first = false;
      blocks.push(block);
    }
  }
}
