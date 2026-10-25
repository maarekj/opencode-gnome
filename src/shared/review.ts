// Revue commentée d'un diff (comme une PR) : commentaires sur des lignes, brouillon conservé par
// dépôt jusqu'à son envoi à l'agent sous forme d'un prompt structuré.
import GLib from 'gi://GLib';
import * as z from 'zod/mini';

/** Diff commenté : modifications non commitées, un commit, ou une comparaison de deux refs. */
export const ReviewOrigin = z.union([
  z.object({ kind: z.literal('changes') }),
  z.object({ kind: z.literal('commit'), hash: z.string() }),
  z.object({ kind: z.literal('compare'), from: z.string(), to: z.string() }),
]);
export type ReviewOrigin = z.output<typeof ReviewOrigin>;

export const ReviewComment = z.object({
  id: z.string(),
  /** chemin du fichier dans le dépôt */
  file: z.string(),
  /** « lignes 12–15 », « ligne 4 (supprimée) »… */
  lines: z.string(),
  /** origine : modifications non commitées, commit abc1234, comparaison main..HEAD */
  source: z.string(),
  /** lignes du diff commentées, préfixées (+, -, espace) */
  excerpt: z.string(),
  text: z.string(),
  created: z.number(),
  /** pour revenir au diff : origine et dernière ligne commentée */
  origin: z.optional(ReviewOrigin),
  end: z.optional(z.object({ new: z.optional(z.number()), old: z.optional(z.number()) })),
});
export type ReviewComment = z.output<typeof ReviewComment>;

const Draft = z.object({ directory: z.string(), comments: z.array(ReviewComment), global: z.prefault(z.string(), '') });

export interface ReviewDraft {
  readonly comments: readonly ReviewComment[];
  /** commentaire général, en plus des commentaires de lignes */
  readonly global: string;
}

/** Brouillons : ~/.local/share/opencode-gnome/reviews/<empreinte du dossier>.json */
const draftPath = (directory: string): string =>
  GLib.build_filenamev([GLib.get_user_data_dir(), 'opencode-gnome', 'reviews', `${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, directory, -1)}.json`]);

export function loadReview(directory: string): ReviewDraft {
  try {
    const [ok, bytes] = GLib.file_get_contents(draftPath(directory));
    if (!ok) return { comments: [], global: '' };
    const parsed = Draft.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? { comments: parsed.data.comments, global: parsed.data.global } : { comments: [], global: '' };
  } catch {
    return { comments: [], global: '' };
  }
}

export function saveReview(directory: string, draft: ReviewDraft): void {
  const path = draftPath(directory);
  const { comments, global } = draft;
  if (comments.length === 0 && global.trim() === '') {
    GLib.unlink(path);
    return;
  }
  GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
  GLib.file_set_contents(path, new TextEncoder().encode(`${JSON.stringify({ directory, comments, global }, null, 2)}\n`));
}

export const newCommentId = (): string => `c${Date.now().toString(36)}${GLib.random_int_range(0, 1296).toString(36)}`;

/** Ordre de lecture : par fichier, puis par position (ordre de création à l'intérieur). */
const sorted = (comments: readonly ReviewComment[]): ReviewComment[] =>
  comments.toSorted((a, b) => a.file.localeCompare(b.file) || firstLine(a.lines) - firstLine(b.lines) || a.created - b.created);
const firstLine = (lines: string): number => Number(/\d+/u.exec(lines)?.[0] ?? 0);

/** Prompt envoyé à l'agent : chaque commentaire avec son fichier, ses lignes et l'extrait du diff. */
export function reviewPrompt(comments: readonly ReviewComment[], global = ''): string {
  const list = sorted(comments);
  const files = new Set(list.map((c) => c.file)).size;
  const parts = [
    list.length === 0
      ? 'Revue de code. Prends en compte le commentaire ci-dessous (modifie le code si besoin), puis récapitule ce que tu as fait.'
      : `Revue de code : ${list.length} commentaire${list.length > 1 ? 's' : ''} sur ${files} fichier${files > 1 ? 's' : ''}. Prends en compte chaque commentaire (modifie le code si besoin), puis récapitule ce que tu as fait pour chacun.`,
  ];
  if (global.trim() !== '') parts.push(`## Commentaire général\n\n${global.trim()}`);
  for (const [i, c] of list.entries()) {
    const fence = c.excerpt.includes('```') ? '~~~' : '```';
    parts.push(`## ${i + 1}. ${c.file} — ${c.lines} (${c.source})\n\n${fence}diff\n${c.excerpt}\n${fence}\n\n${c.text.trim()}`);
  }
  return parts.join('\n\n');
}
