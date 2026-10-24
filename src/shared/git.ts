// Lecture de l'état git d'un dossier (git local, lecture seule) : branche, worktree, amont, fichiers modifiés.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

/** Lance `git -C <dossier> …` ; `null` si git échoue (pas un dépôt, git absent). */
export async function git(directory: string, args: readonly string[]): Promise<string | null> {
  if (GLib.find_program_in_path('git') === null) return null;
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE });
  // pas d'éditeur, de pager ni de verrou d'index pour une lecture
  launcher.setenv('GIT_OPTIONAL_LOCKS', '0', true);
  launcher.setenv('GIT_PAGER', 'cat', true);
  launcher.setenv('LC_ALL', 'C', true);
  const proc = launcher.spawnv(['git', '-C', directory, ...args]);
  const [out] = await proc.communicate_utf8_async(null, null);
  return proc.get_successful() ? (out ?? '') : null;
}

export interface GitStatus {
  /** branche courante, `null` si HEAD détachée */
  readonly branch: string | null;
  /** commit courant (abrégé) */
  readonly commit: string;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  /** fichiers modifiés, indexés ou non suivis */
  readonly changes: number;
  /** racine de la copie de travail */
  readonly toplevel: string;
  /** worktree lié : racine du dépôt principal ; `null` pour le dépôt principal */
  readonly mainWorktree: string | null;
}

/** Interprète `git status --porcelain=v2 --branch`. */
export function parseStatus(out: string): Pick<GitStatus, 'branch' | 'commit' | 'upstream' | 'ahead' | 'behind' | 'changes'> {
  let branch: string | null = null;
  let commit = '';
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let changes = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.oid ')) commit = line.slice(13, 20);
    else if (line.startsWith('# branch.head ')) {
      const head = line.slice(14);
      branch = head === '(detached)' ? null : head;
    } else if (line.startsWith('# branch.upstream ')) upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /^\+(\d+) -(\d+)$/u.exec(line.slice(12));
      ahead = Number(m?.[1] ?? 0);
      behind = Number(m?.[2] ?? 0);
    } else if (line !== '' && !line.startsWith('#')) changes++;
  }
  return { branch, commit, upstream, ahead, behind, changes };
}

/** État git d'un dossier ; `null` hors d'un dépôt. */
export async function gitStatus(directory: string): Promise<GitStatus | null> {
  const [status, paths] = await Promise.all([
    git(directory, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']),
    git(directory, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel']),
  ]);
  if (status === null || paths === null) return null;
  const [gitDir = '', commonDir = '', toplevel = directory] = paths.trim().split('\n');
  // worktree lié : son dossier git est `<commun>/worktrees/<nom>` ; le dépôt principal est le parent du dossier commun
  const linked = gitDir !== commonDir && commonDir !== '';
  const mainWorktree = linked ? (commonDir.endsWith('/.git') ? commonDir.slice(0, -5) : commonDir) : null;
  return { ...parseStatus(status), toplevel, mainWorktree };
}
