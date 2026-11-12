// Types de l'application (agents, modèles, commandes, MCP, skills…), construits depuis l'API
// d'OpenCode 2 (src/shared/v2/, #168) ; les réponses du serveur sont validées par src/shared/v2/schemas.ts.
import * as z from 'zod/mini';

// Projets et sessions : modèle OpenCode 2 (src/shared/v2/schemas.ts, #171)
export type { AppProject as Project, AppSession as Session } from './v2/schemas.ts';

export const SessionStatus = z.looseObject({ type: z.string() }); // idle | busy | retry
export type SessionStatus = z.output<typeof SessionStatus>;

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


/** Config opencode (`GET /config`), champs utilisés. */
export const OpencodeConfig = z.looseObject({ model: z.optional(z.nullable(z.string())) });
export type OpencodeConfig = z.output<typeof OpencodeConfig>;

/** Déclaration d'un serveur MCP dans la configuration (`mcp.<nom>`). */
export const McpConfig = z.looseObject({
  type: z.optional(z.string()),
  command: z.optional(z.array(z.string())),
  url: z.optional(z.string()),
  enabled: z.optional(z.boolean()),
  /** local : variables d'environnement */
  environment: z.optional(z.record(z.string(), z.string())),
  /** distant : en-têtes HTTP (clé d'API…) */
  headers: z.optional(z.record(z.string(), z.string())),
});
export type McpConfig = z.output<typeof McpConfig>;
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
