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
  model: z.optional(z.looseObject({ id: z.string(), providerID: z.string() })),
  cost: z.optional(z.number()),
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
  state: z.optional(ToolState),
  filename: z.optional(z.string()),
  mime: z.optional(z.string()),
});
export type Part = z.output<typeof Part>;

export const MessageInfo = z.looseObject({
  id: z.string(),
  role: z.string(), // user | assistant
  sessionID: z.string(),
  time: z.looseObject({ created: z.number(), completed: z.optional(z.number()) }),
  agent: z.optional(z.string()),
  modelID: z.optional(z.string()),
  providerID: z.optional(z.string()),
  cost: z.optional(z.number()),
  error: z.optional(z.looseObject({ name: z.optional(z.string()), data: z.optional(z.looseObject({ message: z.optional(z.string()) })) })),
});
export type MessageInfo = z.output<typeof MessageInfo>;

export const MessageWithParts = z.looseObject({ info: MessageInfo, parts: z.array(Part) });
export type MessageWithParts = z.output<typeof MessageWithParts>;

export const PermissionRequest = z.looseObject({
  id: z.string(),
  sessionID: z.string(),
  permission: z.string(),
  patterns: z.optional(z.array(z.string())),
  always: z.optional(z.array(z.string())),
  metadata: z.optional(z.unknown()),
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

export const QuestionRequest = z.looseObject({ id: z.string(), sessionID: z.string(), questions: z.array(QuestionInfo) });
export type QuestionRequest = z.output<typeof QuestionRequest>;

export const Agent = z.looseObject({ name: z.string(), mode: z.optional(z.string()), hidden: z.optional(z.nullable(z.boolean())), description: z.optional(z.string()) });
export type Agent = z.output<typeof Agent>;

export const Providers = z.looseObject({
  providers: z.array(z.looseObject({ id: z.string(), name: z.optional(z.string()), models: z.record(z.string(), z.looseObject({ id: z.string(), name: z.optional(z.string()) })) })),
  default: z.record(z.string(), z.string()),
});
export type Providers = z.output<typeof Providers>;

export const FileDiff = z.looseObject({ path: z.string(), status: z.optional(z.string()), additions: z.number(), deletions: z.number(), patch: z.optional(z.string()) });
export type FileDiff = z.output<typeof FileDiff>;

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
  z.object({ type: z.enum(['permission.asked', 'permission.v2.asked']), properties: z.looseObject({ id: z.string(), sessionID: z.string() }) }),
  z.object({ type: z.enum(['permission.replied', 'permission.v2.replied']), properties: z.looseObject({ sessionID: z.string() }) }),
  z.object({
    type: z.enum(['question.asked', 'question.v2.asked', 'question.replied', 'question.v2.replied', 'question.rejected', 'question.v2.rejected']),
    properties: z.looseObject({ sessionID: z.string() }),
  }),
  z.object({ type: z.literal('session.diff'), properties: z.looseObject({ sessionID: z.string() }) }),
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
export type SessionEvent = Extract<AppEvent, { type: `message.${string}` | `permission.${string}` | `question.${string}` | 'session.diff' }>;
export type AppEvent = z.output<typeof AppEvent>;
export type AppEventEnvelope = { directory: string | null; event: AppEvent };
