// Schémas des événements d'OpenCode 2 utilisés (#170) : données réduites aux champs lus, chacune
// vérifiée contre le type officiel (`V2Event` de `@opencode/client`).
import type { V2Event } from '@opencode/client';
import * as z from 'zod/mini';
import { conforms } from './conforms.ts';
import type { Project } from './schemas.ts';

type Data<T extends V2Event['type']> = Extract<V2Event, { type: T }>['data'];

/** Enveloppe d'un événement de `GET /api/event`. */
export const Envelope = z.object({
  type: z.string(),
  /** horodatage (ms) ; absent de `server.connected` */
  created: z.optional(z.number()),
  location: z.optional(z.object({ directory: z.optional(z.string()) })),
  data: z.optional(z.unknown()),
});

const Sid = z.object({ sessionID: z.string() });
export const StructuredError = z.object({ type: z.string(), message: z.string() });
const Model = z.object({ id: z.string(), providerID: z.string(), variant: z.optional(z.string()) });
const Tokens = z.object({ input: z.number(), output: z.number(), reasoning: z.number(), cache: z.object({ read: z.number(), write: z.number() }) });
const Json = z.record(z.string(), z.unknown());
export const ToolContent = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('file'), uri: z.string(), mime: z.string(), name: z.optional(z.nullable(z.string())) }),
]);

export const StepStarted = z.object({ sessionID: z.string(), assistantMessageID: z.string(), agent: z.string(), model: Model, started: z.number() });
export const StepEnded = z.object({
  sessionID: z.string(),
  assistantMessageID: z.string(),
  finish: z.string(),
  cost: z.optional(z.number()),
  tokens: z.optional(Tokens),
});
export const StepFailed = z.object({ sessionID: z.string(), assistantMessageID: z.string(), error: StructuredError, cost: z.optional(z.number()), tokens: z.optional(Tokens) });
export const Block = z.object({ sessionID: z.string(), assistantMessageID: z.string(), ordinal: z.number() });
export const BlockDelta = z.object({ sessionID: z.string(), assistantMessageID: z.string(), ordinal: z.number(), delta: z.string() });
export const BlockEnded = z.object({ sessionID: z.string(), assistantMessageID: z.string(), ordinal: z.number(), text: z.string() });
export const ToolStarted = z.object({ sessionID: z.string(), assistantMessageID: z.string(), id: z.string(), name: z.string() });
export const ToolCalled = z.object({ sessionID: z.string(), assistantMessageID: z.string(), id: z.string(), input: Json });
export const ToolProgress = z.object({ sessionID: z.string(), assistantMessageID: z.string(), id: z.string(), metadata: Json });
export const ToolSuccess = z.object({ sessionID: z.string(), assistantMessageID: z.string(), id: z.string(), content: z.array(ToolContent), metadata: z.optional(Json) });
export const ToolFailed = z.object({ sessionID: z.string(), assistantMessageID: z.string(), id: z.string(), error: StructuredError, content: z.optional(z.array(ToolContent)), metadata: z.optional(Json) });
export const InboxEnqueued = z.object({
  sessionID: z.string(),
  inboxID: z.string(),
  item: z.object({ type: z.string(), payload: z.unknown() }),
});
/** Message de l'utilisateur en file d'attente : texte et pièces jointes (base64, #183). */
export const UserPayload = z.object({ text: z.string(), files: z.optional(z.array(z.object({ data: z.string(), mime: z.string(), name: z.optional(z.string()) }))) });
export const InboxDelivered = z.object({ sessionID: z.string(), inboxID: z.string() });
export const ExecutionFailed = z.object({ sessionID: z.string(), error: StructuredError });
export const RetryScheduled = z.object({ sessionID: z.string(), attempt: z.number(), error: StructuredError });
export const PermissionAsked = z.object({ id: z.string(), sessionID: z.string() });
export const PermissionReplied = z.object({ sessionID: z.string(), requestID: z.string() });
export const FormCreated = z.object({ form: z.object({ id: z.string(), sessionID: z.string() }) });
export const FormSettled = z.object({ id: z.string(), sessionID: z.string() });

conforms<Data<'session.step.started'>, typeof StepStarted>(true);
conforms<Data<'session.step.ended'>, typeof StepEnded>(true);
conforms<Data<'session.step.failed'>, typeof StepFailed>(true);
conforms<Data<'session.text.started'>, typeof Block>(true);
conforms<Data<'session.text.delta'>, typeof BlockDelta>(true);
conforms<Data<'session.text.ended'>, typeof BlockEnded>(true);
conforms<Data<'session.reasoning.started'>, typeof Block>(true);
conforms<Data<'session.reasoning.delta'>, typeof BlockDelta>(true);
conforms<Data<'session.reasoning.ended'>, typeof BlockEnded>(true);
conforms<Data<'session.tool.input.started'>, typeof ToolStarted>(true);
conforms<Data<'session.tool.called'>, typeof ToolCalled>(true);
conforms<Data<'session.tool.progress'>, typeof ToolProgress>(true);
conforms<Data<'session.tool.success'>, typeof ToolSuccess>(true);
conforms<Data<'session.tool.failed'>, typeof ToolFailed>(true);
conforms<Data<'session.inbox.enqueued'>, typeof InboxEnqueued>(true);
conforms<Data<'session.inbox.delivered'>, typeof InboxDelivered>(true);
conforms<Data<'session.execution.started'>, typeof Sid>(true);
conforms<Data<'session.execution.succeeded'>, typeof Sid>(true);
conforms<Data<'session.execution.interrupted'>, typeof Sid>(true);
conforms<Data<'session.execution.failed'>, typeof ExecutionFailed>(true);
conforms<Data<'session.retry.scheduled'>, typeof RetryScheduled>(true);
conforms<Data<'session.created'>, typeof Sid>(true);
conforms<Data<'session.renamed'>, typeof Sid>(true);
conforms<Data<'session.deleted'>, typeof Sid>(true);
conforms<Data<'permission.asked'>, typeof PermissionAsked>(true);
conforms<Data<'permission.replied'>, typeof PermissionReplied>(true);
conforms<Data<'form.created'>, typeof FormCreated>(true);
conforms<Data<'form.replied'>, typeof FormSettled>(true);
conforms<Data<'form.cancelled'>, typeof FormSettled>(true);
conforms<Data<'project.updated'>, typeof Project>(true);

export { Sid };
