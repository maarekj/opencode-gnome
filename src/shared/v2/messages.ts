// Entrées de l'historique d'une session OpenCode 2 (#171) : un schéma par type, champs lus
// seulement, chacun vérifié contre le type officiel (`SessionMessage*` de `@opencode/client`).
import type {
  SessionMessageAgentSelected,
  SessionMessageAssistant,
  SessionMessageCompaction,
  SessionMessageIdle,
  SessionMessageInfo,
  SessionMessageModelSelected,
  SessionMessageShell,
  SessionMessageSkill,
  SessionMessageSynthetic,
  SessionMessageSystem,
  SessionMessageUser,
} from '@opencode/client';
import * as z from 'zod/mini';
import { conforms } from './conforms.ts';
import { StructuredError, ToolContent } from './events.ts';

const Model = z.object({ id: z.string(), providerID: z.string(), variant: z.optional(z.string()) });
const Tokens = z.object({ input: z.number(), output: z.number(), reasoning: z.number(), cache: z.object({ read: z.number(), write: z.number() }) });
const Json = z.record(z.string(), z.unknown());
const Created = z.object({ created: z.number() });

export const UserFile = z.object({ data: z.string(), mime: z.string(), name: z.optional(z.string()) });
export const UserMessage = z.object({ type: z.literal('user'), id: z.string(), time: Created, text: z.string(), files: z.optional(z.array(UserFile)) });

export const TextContent = z.object({ type: z.literal('text'), text: z.string() });
export const ReasoningContent = z.object({ type: z.literal('reasoning'), text: z.string(), time: z.optional(z.object({ created: z.number(), completed: z.optional(z.number()) })) });
export const ToolState = z.union([
  z.object({ status: z.literal('streaming'), input: z.string() }),
  z.object({ status: z.literal('running'), input: Json, metadata: Json }),
  z.object({ status: z.literal('completed'), input: Json, content: z.array(ToolContent), metadata: z.optional(Json) }),
  z.object({ status: z.literal('error'), input: Json, error: StructuredError, content: z.optional(z.array(ToolContent)), metadata: z.optional(Json) }),
]);
export const ToolContentBlock = z.object({
  type: z.literal('tool'),
  id: z.string(),
  name: z.string(),
  state: ToolState,
  time: z.object({ created: z.number(), ran: z.optional(z.number()), completed: z.optional(z.number()) }),
});
export const AssistantMessage = z.object({
  type: z.literal('assistant'),
  id: z.string(),
  time: z.object({ created: z.number(), completed: z.optional(z.number()) }),
  agent: z.string(),
  model: Model,
  content: z.array(z.union([TextContent, ReasoningContent, ToolContentBlock])),
  cost: z.optional(z.number()),
  tokens: z.optional(Tokens),
  error: z.optional(StructuredError),
});
export const ShellMessage = z.object({
  type: z.literal('shell'),
  id: z.string(),
  time: z.object({ created: z.number(), completed: z.optional(z.number()) }),
  command: z.string(),
  status: z.string(),
  exit: z.optional(z.union([z.number(), z.string()])),
  output: z.optional(z.object({ output: z.string(), truncated: z.boolean() })),
});
export const CompactionMessage = z.object({
  type: z.literal('compaction'),
  id: z.string(),
  time: Created,
  status: z.string(),
  summary: z.optional(z.string()),
  error: z.optional(StructuredError),
});
export const SyntheticMessage = z.object({ type: z.literal('synthetic'), id: z.string(), time: Created, text: z.string(), description: z.optional(z.string()) });
export const SystemMessage = z.object({ type: z.literal('system'), id: z.string(), time: Created, text: z.string(), description: z.optional(z.string()) });
export const SkillMessage = z.object({ type: z.literal('skill'), id: z.string(), time: Created, name: z.string() });
export const AgentSwitched = z.object({ type: z.literal('agent-switched'), id: z.string(), time: Created, agent: z.string() });
export const ModelSwitched = z.object({ type: z.literal('model-switched'), id: z.string(), time: Created, model: Model });
export const IdleMessage = z.object({ type: z.literal('idle'), id: z.string(), time: Created, outcome: z.string(), error: z.optional(StructuredError) });

/** Entrée de l'historique ; types inconnus (`location-switched`…) : `other`. */
export const HistoryEntry = z.union([
  UserMessage,
  AssistantMessage,
  ShellMessage,
  CompactionMessage,
  SyntheticMessage,
  SystemMessage,
  SkillMessage,
  AgentSwitched,
  ModelSwitched,
  IdleMessage,
  z.object({ type: z.string(), id: z.string(), time: Created }),
]);
export type HistoryEntry = z.output<typeof HistoryEntry>;
export type AssistantMessage = z.output<typeof AssistantMessage>;
export type ToolContentBlock = z.output<typeof ToolContentBlock>;

conforms<SessionMessageUser, typeof UserMessage>(true);
conforms<SessionMessageAssistant, typeof AssistantMessage>(true);
conforms<SessionMessageShell, typeof ShellMessage>(true);
conforms<SessionMessageCompaction, typeof CompactionMessage>(true);
conforms<SessionMessageSynthetic, typeof SyntheticMessage>(true);
conforms<SessionMessageSystem, typeof SystemMessage>(true);
conforms<SessionMessageSkill, typeof SkillMessage>(true);
conforms<SessionMessageAgentSelected, typeof AgentSwitched>(true);
conforms<SessionMessageModelSelected, typeof ModelSwitched>(true);
conforms<SessionMessageIdle, typeof IdleMessage>(true);
conforms<SessionMessageInfo, typeof HistoryEntry>(true);
