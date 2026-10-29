// Chemins relatifs à un projet (terminaux, devenv), sans dépendance à l'interface.
import GLib from 'gi://GLib';

/** Répertoire `cwd` relatif au projet (vide : le projet ; absolu et ~/… acceptés). */
export function resolveCwd(cwd: string | undefined, project: string): string {
  const c = (cwd ?? '').trim();
  if (c === '' || c === '.') return project;
  if (c === '~' || c.startsWith('~/')) return GLib.build_filenamev([GLib.get_home_dir(), c.slice(1)]);
  if (GLib.path_is_absolute(c)) return c;
  return GLib.canonicalize_filename(c, project);
}
