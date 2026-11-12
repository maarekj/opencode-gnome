// Schémas zod des réponses d'OpenCode 2 (#169) : seulement les champs utilisés, chacun vérifié
// contre le type officiel (`conforms` dans client.ts). Les champs inconnus sont ignorés.
import * as z from 'zod/mini';

export const Info = z.object({
  version: z.string(),
  pid: z.number(),
  hostname: z.optional(z.string()),
  urls: z.array(z.string()),
  paths: z.object({ tmp: z.string() }),
  capabilities: z.optional(z.object({ persistentPty: z.optional(z.boolean()) })),
});

export const Project = z.object({
  id: z.string(),
  /** dossier du projet */
  canonical: z.string(),
  name: z.optional(z.string()),
  vcs: z.optional(z.string()),
  time: z.object({ created: z.number(), updated: z.number() }),
});
export type ProjectV2 = z.infer<typeof Project>;

const Tokens = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cache: z.object({ read: z.number(), write: z.number() }),
});

export const Session = z.object({
  id: z.string(),
  parentID: z.optional(z.string()),
  projectID: z.string(),
  title: z.optional(z.string()),
  agent: z.optional(z.string()),
  model: z.optional(z.object({ id: z.string(), providerID: z.string(), variant: z.optional(z.string()) })),
  cost: z.number(),
  tokens: Tokens,
  outcome: z.optional(z.enum(['succeeded', 'failed', 'interrupted'])),
  time: z.object({
    created: z.number(),
    updated: z.number(),
    busy: z.optional(z.number()),
    idle: z.optional(z.number()),
    archived: z.optional(z.number()),
  }),
  location: z.object({ directory: z.string() }),
});
export type SessionV2 = z.infer<typeof Session>;

const Cursor = z.object({ previous: z.optional(z.nullable(z.string())), next: z.optional(z.nullable(z.string())) });
export const SessionPage = z.object({ data: z.array(Session), cursor: Cursor });

/** Statut d'une session active. */
export const Status = z.object({ type: z.string() });

/**
 * Entrée de l'historique d'une session (user, assistant, shell, compaction, idle…). Détail par
 * type : affichage des messages (#171).
 */
export const Message = z.looseObject({
  id: z.string(),
  type: z.string(),
  time: z.object({ created: z.number() }),
});
export type MessageV2 = z.infer<typeof Message>;
export const Messages = z.object({ data: z.array(Message), cursor: Cursor });
