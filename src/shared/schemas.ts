// Schémas des données opencode consommées (opencode serve, API HTTP + SSE).
// Objets « loose » : les champs inconnus sont conservés, l'API évolue vite.
import * as z from 'zod/mini';

export const Time = z.looseObject({ created: z.number(), updated: z.optional(z.number()) });

export const Project = z.looseObject({
  id: z.string(),
  worktree: z.string(),
  vcs: z.optional(z.string()),
  name: z.optional(z.string()),
  time: z.optional(Time),
});
export type Project = z.output<typeof Project>;

export const Session = z.looseObject({
  id: z.string(),
  projectID: z.string(),
  directory: z.string(),
  parentID: z.optional(z.string()),
  title: z.string(),
  agent: z.optional(z.string()),
  model: z.optional(z.looseObject({ id: z.string(), providerID: z.string(), variant: z.optional(z.string()) })),
  cost: z.optional(z.number()),
  /** messages annulés (`/undo`) à partir de `messageID` */
  revert: z.optional(z.nullable(z.looseObject({ messageID: z.string() }))),
  time: Time,
  /** présent dans /experimental/session */
  project: z.optional(z.looseObject({ id: z.string(), worktree: z.string() })),
});
export type Session = z.output<typeof Session>;

export const SessionStatus = z.looseObject({ type: z.string() }); // idle | busy | retry
export type SessionStatus = z.output<typeof SessionStatus>;

export const Health = z.looseObject({ healthy: z.boolean(), version: z.string() });
export type Health = z.output<typeof Health>;

export const ToolState = z.looseObject({
  status: z.string(), // pending | running | completed | error
  title: z.optional(z.string()),
  time: z.optional(z.looseObject({ start: z.optional(z.number()), end: z.optional(z.number()) })),
  input: z.optional(z.unknown()),
  output: z.optional(z.unknown()),
  error: z.optional(z.unknown()),
  metadata: z.optional(z.unknown()),
});
export type ToolState = z.output<typeof ToolState>;

/** Partie d'un message : text, reasoning, tool, file, step-start, step-finish, patch, agent… */
export const Part = z.looseObject({
  id: z.string(),
  type: z.string(),
  messageID: z.string(),
  sessionID: z.string(),
  text: z.optional(z.string()),
  synthetic: z.optional(z.boolean()),
  ignored: z.optional(z.boolean()),
  tool: z.optional(z.string()),
  /** identifiant de l'appel d'outil (relie une permission / question à son appel) */
  callID: z.optional(z.string()),
  state: z.optional(ToolState),
  filename: z.optional(z.string()),
  mime: z.optional(z.string()),
  /** début / fin de génération (texte, réflexion) */
  time: z.optional(z.looseObject({ start: z.optional(z.number()), end: z.optional(z.number()) })),
  /** fichier : URL `data:` (contenu en base64) ou `file://` */
  url: z.optional(z.string()),
});
export type Part = z.output<typeof Part>;

export const MessageInfo = z.looseObject({
  id: z.string(),
  role: z.string(), // user | assistant
  sessionID: z.string(),
  /** assistant : message utilisateur auquel il répond (tour) */
  parentID: z.optional(z.string()),
  time: z.looseObject({ created: z.number(), completed: z.optional(z.number()) }),
  agent: z.optional(z.string()),
  modelID: z.optional(z.string()),
  providerID: z.optional(z.string()),
  cost: z.optional(z.number()),
  /** niveau de raisonnement utilisé (low, high…) */
  variant: z.optional(z.string()),
  tokens: z.optional(
    z.looseObject({
      input: z.number(),
      output: z.number(),
      reasoning: z.optional(z.number()),
      cache: z.optional(z.looseObject({ read: z.number(), write: z.number() })),
    }),
  ),
  error: z.optional(z.looseObject({ name: z.optional(z.string()), data: z.optional(z.looseObject({ message: z.optional(z.string()) })) })),
});
export type MessageInfo = z.output<typeof MessageInfo>;

export const MessageWithParts = z.looseObject({ info: MessageInfo, parts: z.array(Part) });
export type MessageWithParts = z.output<typeof MessageWithParts>;

/** Appel d'outil à l'origine d'une demande. */
export const RequestTool = z.looseObject({ messageID: z.string(), callID: z.string() });

export const PermissionRequest = z.looseObject({
  id: z.string(),
  sessionID: z.string(),
  permission: z.string(),
  patterns: z.optional(z.array(z.string())),
  always: z.optional(z.array(z.string())),
  metadata: z.optional(z.unknown()),
  tool: z.optional(RequestTool),
});
export type PermissionRequest = z.output<typeof PermissionRequest>;

export const QuestionInfo = z.looseObject({
  question: z.string(),
  header: z.optional(z.string()),
  options: z.array(z.looseObject({ label: z.string(), description: z.optional(z.string()) })),
  multiple: z.optional(z.boolean()),
  custom: z.optional(z.boolean()),
});
export type QuestionInfo = z.output<typeof QuestionInfo>;

export const QuestionRequest = z.looseObject({ id: z.string(), sessionID: z.string(), questions: z.array(QuestionInfo), tool: z.optional(RequestTool) });
export type QuestionRequest = z.output<typeof QuestionRequest>;

export const Agent = z.looseObject({
  name: z.string(),
  mode: z.optional(z.string()),
  hidden: z.optional(z.nullable(z.boolean())),
  description: z.optional(z.string()),
  variant: z.optional(z.nullable(z.string())),
});
export type Agent = z.output<typeof Agent>;

export const ProviderModel = z.looseObject({
  id: z.string(),
  name: z.optional(z.string()),
  limit: z.optional(z.looseObject({ context: z.number() })),
  /** niveaux de raisonnement disponibles (nom -> options), dans l'ordre du serveur */
  variants: z.optional(z.record(z.string(), z.unknown())),
});
export type ProviderModel = z.output<typeof ProviderModel>;

export const Providers = z.looseObject({
  providers: z.array(z.looseObject({ id: z.string(), name: z.optional(z.string()), models: z.record(z.string(), ProviderModel) })),
  default: z.record(z.string(), z.string()),
});
export type Providers = z.output<typeof Providers>;

/** Tâche de la liste de tâches d'une session (outil `todowrite`). */
export const Todo = z.looseObject({
  content: z.string(),
  status: z.string(), // pending | in_progress | completed | cancelled
  priority: z.optional(z.string()), // high | medium | low
});
export type Todo = z.output<typeof Todo>;

/** Fichier modifié dans le dépôt git (`GET /vcs/diff?mode=git`). */
export const FileDiff = z.looseObject({ file: z.string(), status: z.optional(z.string()), additions: z.number(), deletions: z.number(), patch: z.optional(z.string()) });

export const VcsInfo = z.looseObject({ branch: z.optional(z.nullable(z.string())) });
export type VcsInfo = z.output<typeof VcsInfo>;

/** Config opencode (`GET /config`), champs utilisés. */
export const OpencodeConfig = z.looseObject({ model: z.optional(z.nullable(z.string())) });
export type OpencodeConfig = z.output<typeof OpencodeConfig>;

/** Déclaration d'un serveur MCP dans la configuration (`mcp.<nom>`). */
export const McpConfig = z.looseObject({
  type: z.optional(z.string()),
  command: z.optional(z.array(z.string())),
  url: z.optional(z.string()),
  enabled: z.optional(z.boolean()),
});
export type McpConfig = z.output<typeof McpConfig>;
/** Configuration réduite aux serveurs MCP. */
export const McpSection = z.looseObject({ mcp: z.optional(z.nullable(z.record(z.string(), McpConfig))) });

/** Configuration réduite aux plugins : `"nom@version"`, `"file://…"` ou `[nom, options]`. */
export const PluginSection = z.looseObject({ plugin: z.optional(z.nullable(z.array(z.unknown()))) });

/** État d'un serveur MCP (`GET /mcp`). */
export const McpStatus = z.looseObject({
  /** connected | disabled | failed | needs_auth | needs_client_registration */
  status: z.string(),
  error: z.optional(z.string()),
});
export type McpStatus = z.output<typeof McpStatus>;

/** Skill disponible (`GET /skill`). */
export const Skill = z.looseObject({
  name: z.string(),
  description: z.optional(z.string()),
  /** chemin du SKILL.md, ou `<built-in>` */
  location: z.string(),
});
export type Skill = z.output<typeof Skill>;
export type FileDiff = z.output<typeof FileDiff>;

/** Commande du serveur (`GET /command`) : commande intégrée, de l'utilisateur, du projet, skill ou MCP. */
export const Command = z.looseObject({
  name: z.string(),
  description: z.optional(z.nullable(z.string())),
  /** command | skill | mcp */
  source: z.optional(z.nullable(z.string())),
  agent: z.optional(z.nullable(z.string())),
  model: z.optional(z.nullable(z.string())),
  subtask: z.optional(z.nullable(z.boolean())),
  /** arguments attendus (`$ARGUMENTS`, `$1`…) */
  hints: z.optional(z.nullable(z.array(z.string()))),
});
export type Command = z.output<typeof Command>;

/** Session partagée : lien public. */
export const SharedSession = z.looseObject({ share: z.optional(z.nullable(z.looseObject({ url: z.string() }))) });

/** Mention `@chemin` d'un fichier ou dossier du projet, envoyée comme partie `file` (comme la TUI). */
export interface Mention {
  /** chemin relatif au répertoire de la session (`src/app/` pour un dossier) */
  readonly path: string;
  readonly directory: boolean;
  /** position de `@chemin` dans le texte envoyé (indices de chaîne JS) */
  readonly start: number;
  readonly end: number;
}

/** Pièce jointe envoyée avec un prompt (`FilePartInput`). */
export interface Attachment {
  readonly mime: string;
  readonly filename: string;
  /** `data:<mime>;base64,…` ou `file:///chemin` */
  readonly url: string;
}

/** Enveloppe de `GET /global/event` : un événement bus + son répertoire d'origine. */
export const GlobalEnvelope = z.looseObject({
  directory: z.optional(z.nullable(z.string())),
  payload: z.looseObject({ type: z.string(), properties: z.optional(z.unknown()) }),
});

/** Événements dont l'app a besoin. Les autres sont ignorés. */
export const AppEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('server.connected') }),
  z.object({ type: z.enum(['session.created', 'session.updated']), properties: z.looseObject({ info: Session }) }),
  z.object({ type: z.literal('session.deleted'), properties: z.looseObject({ sessionID: z.string() }) }),
  z.object({ type: z.literal('session.status'), properties: z.looseObject({ sessionID: z.string(), status: SessionStatus }) }),
  z.object({ type: z.literal('session.idle'), properties: z.looseObject({ sessionID: z.string() }) }),
  z.object({
    type: z.literal('session.error'),
    properties: z.looseObject({
      sessionID: z.optional(z.string()),
      error: z.optional(z.looseObject({ name: z.optional(z.string()), data: z.optional(z.looseObject({ message: z.optional(z.string()) })) })),
    }),
  }),
  z.object({ type: z.enum(['permission.asked', 'permission.v2.asked']), properties: z.looseObject({ id: z.string(), sessionID: z.string() }) }),
  z.object({ type: z.enum(['permission.replied', 'permission.v2.replied']), properties: z.looseObject({ sessionID: z.string() }) }),
  z.object({
    type: z.enum(['question.asked', 'question.v2.asked', 'question.replied', 'question.v2.replied', 'question.rejected', 'question.v2.rejected']),
    properties: z.looseObject({ sessionID: z.string() }),
  }),
  z.object({ type: z.literal('session.diff'), properties: z.looseObject({ sessionID: z.string() }) }),
  z.object({ type: z.literal('todo.updated'), properties: z.looseObject({ sessionID: z.string(), todos: z.array(Todo) }) }),
  z.object({ type: z.literal('project.updated'), properties: Project }),
  z.object({ type: z.literal('message.updated'), properties: z.looseObject({ sessionID: z.string(), info: MessageInfo }) }),
  z.object({ type: z.literal('message.removed'), properties: z.looseObject({ sessionID: z.string(), messageID: z.string() }) }),
  z.object({ type: z.literal('message.part.updated'), properties: z.looseObject({ sessionID: z.string(), part: Part }) }),
  z.object({ type: z.literal('message.part.removed'), properties: z.looseObject({ sessionID: z.string(), messageID: z.string(), partID: z.string() }) }),
  z.object({
    type: z.literal('message.part.delta'),
    properties: z.looseObject({ sessionID: z.string(), messageID: z.string(), partID: z.string(), field: z.string(), delta: z.string() }),
  }),
]);
export type MessageEvent = Extract<AppEvent, { type: `message.${string}` }>;
/** Événements transmis aux conversations ouvertes. */
export type SessionEvent = Extract<AppEvent, { type: `message.${string}` | `permission.${string}` | `question.${string}` | 'session.diff' | 'todo.updated' }>;
export type AppEvent = z.output<typeof AppEvent>;
export type AppEventEnvelope = { directory: string | null; event: AppEvent };
