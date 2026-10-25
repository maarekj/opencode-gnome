// Projet visé par `ocg terminal` / `ocg link` : --project, sinon le dossier courant (racine du
// dépôt git s'il y en a un : le même projet que dans l'application).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { expand } from './args.ts';

function gitRoot(dir: string): string | null {
  try {
    const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE });
    launcher.set_cwd(dir);
    const proc = launcher.spawnv(['git', 'rev-parse', '--show-toplevel']);
    const [, out] = proc.communicate_utf8(null, null);
    const root = proc.get_successful() ? (out ?? '').trim() : '';
    return root === '' ? null : root;
  } catch {
    return null; // git absent
  }
}

/** Dossier du projet : `--project`, sinon la racine git du dossier courant, sinon le dossier courant. */
export function projectDir(option: string | undefined): string {
  const dir = option === undefined ? GLib.get_current_dir() : expand(option);
  if (!GLib.file_test(dir, GLib.FileTest.IS_DIR)) throw new Error(`dossier introuvable : ${dir}`);
  return option === undefined ? (gitRoot(dir) ?? dir) : dir;
}
