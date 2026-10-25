// Aide : guide d'utilisation (docs/guide.md) et version de l'application (package.json),
// lus à l'exécution depuis le dépôt (le lanceur installé exécute dist/ du dépôt lui-même).
import GLib from 'gi://GLib';
import * as z from 'zod/mini';

/** Dépôt du projet. */
export const REPOSITORY = 'https://github.com/maarekj/opencode-gnome';

/** Racine du dépôt, à partir de l'URL d'un bundle (dist/app/main.js, dist/cli/ocg.js). */
export function repoRoot(bundleUrl: string): string {
  return GLib.build_filenamev([GLib.path_get_dirname(GLib.filename_from_uri(bundleUrl)[0]), '..', '..']);
}

function readText(path: string): string | null {
  try {
    const [ok, bytes] = GLib.file_get_contents(path);
    return ok ? new TextDecoder().decode(bytes) : null;
  } catch {
    return null;
  }
}

/** Texte du guide d'utilisation ; message d'erreur en markdown s'il est introuvable. */
export function readGuide(root: string): string {
  const path = GLib.build_filenamev([root, 'docs', 'guide.md']);
  return readText(path) ?? `# Guide introuvable\n\nLe fichier \`${path}\` n'a pas pu être lu.`;
}

const Package = z.looseObject({ version: z.string() });

/** Version de l'application (package.json), null si illisible. */
export function appVersion(root: string): string | null {
  const text = readText(GLib.build_filenamev([root, 'package.json']));
  if (text === null) return null;
  try {
    const parsed = Package.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.version : null;
  } catch {
    return null;
  }
}
