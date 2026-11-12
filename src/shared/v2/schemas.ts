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
  /** messages annulés à partir de `messageID` (annulation en cours, pas encore validée) */
  revert: z.optional(z.object({ messageID: z.string() })),
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

/** Demande de permission en attente (`GET /api/permission/request`). */
export const PermissionV2 = z.object({
  id: z.string(),
  sessionID: z.string(),
  action: z.string(),
  resources: z.array(z.string()),
  save: z.optional(z.array(z.string())),
  metadata: z.optional(z.record(z.string(), z.unknown())),
  /** appel d'outil à l'origine de la demande */
  source: z.optional(z.object({ type: z.string(), messageID: z.string(), id: z.string() })),
  message: z.optional(z.string()),
});
export type PermissionV2 = z.infer<typeof PermissionV2>;
export const PermissionList = z.object({ data: z.array(PermissionV2) });

/** Formulaire en attente (questions de l'agent, `GET /api/form`). Champs : #173. */
export const FormV2 = z.looseObject({ id: z.string(), sessionID: z.string(), title: z.string() });
export type FormV2 = z.infer<typeof FormV2>;
export const FormList = z.object({ data: z.array(FormV2) });

// ------------------------------------------------------------- modèle de l'application

/** Session de l'application : session v2, dossier à plat, titre toujours présent. */
export interface AppSession {
  readonly id: string;
  readonly projectID: string;
  readonly directory: string;
  readonly parentID?: string;
  readonly title: string;
  readonly agent?: string;
  readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string | undefined };
  readonly cost: number;
  readonly revert?: { readonly messageID: string };
  readonly time: { readonly created: number; readonly updated: number; readonly archived?: number };
}

export function appSession(s: SessionV2): AppSession {
  return {
    id: s.id,
    projectID: s.projectID,
    directory: s.location.directory,
    ...(s.parentID === undefined ? {} : { parentID: s.parentID }),
    title: s.title ?? '',
    ...(s.agent === undefined ? {} : { agent: s.agent }),
    ...(s.model === undefined ? {} : { model: s.model }),
    cost: s.cost,
    ...(s.revert === undefined ? {} : { revert: s.revert }),
    time: { created: s.time.created, updated: s.time.updated, ...(s.time.archived === undefined ? {} : { archived: s.time.archived }) },
  };
}

/** Projet de l'application : `worktree` = dossier du projet. */
export interface AppProject {
  readonly id: string;
  readonly worktree: string;
  readonly vcs?: string;
  readonly name?: string;
  readonly time: { readonly created: number; readonly updated: number };
}

export const appProject = (p: ProjectV2): AppProject => ({
  id: p.id,
  worktree: p.canonical,
  ...(p.vcs === undefined ? {} : { vcs: p.vcs }),
  ...(p.name === undefined ? {} : { name: p.name }),
  time: { created: p.time.created, updated: p.time.updated },
});

// ------------------------------------------------------------- choix du compositeur (#172)

export const AgentV2 = z.object({
  id: z.string(),
  name: z.string(),
  description: z.optional(z.string()),
  mode: z.enum(['subagent', 'primary', 'all']),
  hidden: z.boolean(),
  model: z.optional(z.object({ id: z.string(), providerID: z.string(), variant: z.optional(z.string()) })),
});
export const AgentList = z.object({ data: z.array(AgentV2) });

export const ModelV2 = z.object({
  id: z.string(),
  modelID: z.string(),
  providerID: z.string(),
  name: z.string(),
  variants: z.array(z.object({ id: z.string() })),
  enabled: z.boolean(),
  limit: z.object({ context: z.number(), output: z.number() }),
});
export type ModelV2 = z.infer<typeof ModelV2>;
export const ModelList = z.object({ data: z.array(ModelV2) });
export const ModelDefault = z.object({ data: z.nullable(ModelV2) });

export const CommandList = z.object({ data: z.array(z.object({ name: z.string(), description: z.optional(z.string()) })) });
export const FileFind = z.object({ data: z.array(z.object({ path: z.string(), type: z.enum(['file', 'directory']) })) });
export const VcsDiff = z.object({ data: z.array(z.object({ file: z.string(), patch: z.string(), additions: z.number(), deletions: z.number(), status: z.string() })) });
