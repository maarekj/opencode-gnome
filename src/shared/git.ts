// Lecture de l'état git d'un dossier (git local, lecture seule) : branche, worktree, amont, fichiers modifiés.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_async', 'communicate_finish');

/** Lance `git -C <dossier> …` ; `null` si git échoue (pas un dépôt, git absent). */
export async function git(directory: string, args: readonly string[]): Promise<string | null> {
  if (GLib.find_program_in_path('git') === null) return null;
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE });
  // pas d'éditeur, de pager ni de verrou d'index pour une lecture
  launcher.setenv('GIT_OPTIONAL_LOCKS', '0', true);
  launcher.setenv('GIT_PAGER', 'cat', true);
  launcher.setenv('LC_ALL', 'C', true);
  const proc = launcher.spawnv(['git', '-C', directory, ...args]);
  // en octets : la sortie peut contenir des NUL (`-z`), que la variante UTF-8 tronque
  const [out] = await proc.communicate_async(null, null);
  if (!proc.get_successful()) return null;
  const data = out?.toArray();
  return data === undefined ? '' : new TextDecoder().decode(data);
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

// ------------------------------------------------------------------ journal

const US = '\u001F';
const RS = '\u001E';

export interface GitCommit {
  readonly hash: string;
  readonly short: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly email: string;
  /** date d'auteur (ms) */
  readonly date: number;
  readonly committer: string;
  readonly committed: number;
  /** branches, tags, HEAD pointant sur ce commit (`%D`) */
  readonly refs: readonly string[];
  readonly subject: string;
  /** message complet (détail seulement) */
  readonly body: string;
}

const LOG_FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%at', '%cn', '%ct', '%D', '%s'].join('%x1f');

function parseCommit(record: string, body = ''): GitCommit | null {
  const [hash = '', short = '', parents = '', author = '', email = '', at = '0', committer = '', ct = '0', refs = '', subject = ''] = record.replace(/^\n/u, '').split(US);
  if (hash === '') return null;
  return {
    hash,
    short,
    parents: parents === '' ? [] : parents.split(' '),
    author,
    email,
    date: Number(at) * 1000,
    committer,
    committed: Number(ct) * 1000,
    refs: refs === '' ? [] : refs.split(', '),
    subject,
    body,
  };
}

/**
 * Commits accessibles depuis `refs` (le plus récent d'abord). Ordre `--date-order` : un commit
 * apparaît toujours avant ses parents (nécessaire au graphe des branches).
 */
export async function gitLog(directory: string, refs: readonly string[], limit: number): Promise<GitCommit[]> {
  const out = await git(directory, ['log', '--date-order', `--format=${LOG_FORMAT}%x1e`, `--max-count=${limit}`, ...refs, '--']);
  if (out === null) throw new Error(`Journal de ${refs.join(' ')} illisible`);
  return out
    .split(RS)
    .map((r) => parseCommit(r))
    .filter((c): c is GitCommit => c !== null);
}

// ------------------------------------------------------------------ graphe des branches

/** Trait du graphe dans une ligne : de la colonne `from` à la colonne `to`, couleur `color`. */
export interface GraphEdge {
  readonly from: number;
  readonly to: number;
  readonly color: number;
}

/** Une ligne du graphe : point du commit et traits au-dessus (vers le point) et au-dessous. */
export interface GraphRow {
  readonly col: number;
  readonly color: number;
  /** du haut de la ligne au niveau du point */
  readonly up: readonly GraphEdge[];
  /** du niveau du point au bas de la ligne */
  readonly down: readonly GraphEdge[];
}

/**
 * Plan « ligne de métro » : chaque colonne (voie) attend un commit ; un commit prend la voie qui
 * l'attend (les autres voies qui l'attendaient le rejoignent : fusion des branches vers le passé),
 * puis la passe à son premier parent ; ses autres parents (fusion) ouvrent de nouvelles voies.
 */
export function commitGraph(commits: readonly GitCommit[]): { rows: GraphRow[]; width: number } {
  const lanes: ({ hash: string; color: number } | null)[] = [];
  let nextColor = 0;
  let width = 1;
  const free = (): number => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };
  const rows = commits.map((c): GraphRow => {
    let col = lanes.findIndex((l) => l?.hash === c.hash);
    let color: number;
    if (col === -1) {
      col = free();
      color = nextColor++;
    } else color = lanes[col]?.color ?? 0;
    const up: GraphEdge[] = [];
    for (const [k, l] of lanes.entries()) {
      if (l === null) continue;
      up.push({ from: k, to: l.hash === c.hash ? col : k, color: l.color });
      if (l.hash === c.hash) lanes[k] = null;
    }
    const down: GraphEdge[] = [];
    // voies qui continuent sans toucher ce commit
    for (const [k, l] of lanes.entries()) if (l !== null) down.push({ from: k, to: k, color: l.color });
    for (const [i, p] of c.parents.entries()) {
      const existing = lanes.findIndex((l) => l?.hash === p);
      if (i === 0 && existing > col) {
        // premier parent attendu plus à droite : cette voie revient sur la nôtre (la branche
        // principale garde sa colonne et sa couleur)
        const moved = lanes[existing];
        lanes[existing] = null;
        const at = down.findIndex((e) => e.from === existing && e.to === existing);
        if (at !== -1) down.splice(at, 1, { from: existing, to: col, color: moved?.color ?? color });
        lanes[col] = { hash: p, color };
        down.push({ from: col, to: col, color });
        continue;
      }
      if (existing !== -1) {
        // parent déjà attendu sur une autre voie : on la rejoint
        down.push({ from: col, to: existing, color: i === 0 ? color : (lanes[existing]?.color ?? color) });
        continue;
      }
      const k = i === 0 ? col : free();
      const lc = i === 0 ? color : nextColor++;
      lanes[k] = { hash: p, color: lc };
      down.push({ from: col, to: k, color: lc });
    }
    while (lanes.length > 0 && lanes.at(-1) === null) lanes.pop();
    width = Math.max(width, col + 1, lanes.length);
    return { col, color, up, down };
  });
  return { rows, width };
}

export interface GitFileChange {
  readonly path: string;
  /** ancien chemin (renommage, copie) */
  readonly from?: string;
  /** A, M, D, R, C, T */
  readonly status: string;
  /** `null` : fichier binaire */
  readonly additions: number | null;
  readonly deletions: number | null;
}

/** Fichiers d'une sortie `--name-status -z` + `--numstat -z` (mêmes options de diff). */
function parseChanges(nameStatus: string, numstat: string): GitFileChange[] {
  const counts = new Map<string, { add: number | null; del: number | null }>();
  const nums = numstat.split('\0');
  for (let i = 0; i < nums.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/u.exec(nums[i] ?? '');
    if (m === null) continue;
    let path = m[3] ?? '';
    // renommage : « a\td\t\0ancien\0nouveau »
    if (path === '') {
      path = nums[i + 2] ?? '';
      i += 2;
    }
    counts.set(path, { add: m[1] === '-' ? null : Number(m[1]), del: m[2] === '-' ? null : Number(m[2]) });
  }
  const out: GitFileChange[] = [];
  const parts = nameStatus.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i] ?? '';
    if (code === '') continue;
    const status = code.charAt(0);
    let path = parts[++i] ?? '';
    let from: string | undefined;
    if (status === 'R' || status === 'C') {
      from = path;
      path = parts[++i] ?? '';
    }
    const c = counts.get(path);
    out.push({ path, ...(from === undefined ? {} : { from }), status, additions: c?.add ?? null, deletions: c?.del ?? null });
  }
  return out;
}

/** Diff d'un commit (par rapport à son premier parent) ou entre deux refs (`base..cible` : `[base, cible]`). */
/**
 * `mergeBase` : changements de `to` depuis l'ancêtre commun avec `from` (`git diff from...to`),
 * sinon différence directe entre les deux états.
 */
export type DiffTarget = { readonly commit: string } | { readonly from: string; readonly to: string; readonly mergeBase?: boolean };

const diffArgs = (t: DiffTarget): string[] => {
  if ('commit' in t) return ['show', '--diff-merges=first-parent', '--format=', t.commit];
  return t.mergeBase === true ? ['diff', `${t.from}...${t.to}`] : ['diff', t.from, t.to];
};

/** Identifiant complet du commit désigné par `ref` (branche, tag, identifiant abrégé, `HEAD~2`…). */
export async function gitResolve(directory: string, ref: string): Promise<string | null> {
  if (ref.trim() === '' || ref.startsWith('-')) return null;
  const out = await git(directory, ['rev-parse', '--verify', '--quiet', `${ref.trim()}^{commit}`]);
  return out === null ? null : out.trim();
}

/** Fichiers modifiés par un commit ou entre deux refs. */
export async function gitChanges(directory: string, target: DiffTarget): Promise<GitFileChange[]> {
  const [names, nums] = await Promise.all([
    git(directory, [...diffArgs(target), '-M', '--name-status', '-z', '--']),
    git(directory, [...diffArgs(target), '-M', '--numstat', '-z', '--']),
  ]);
  if (names === null || nums === null) throw new Error('Fichiers modifiés illisibles');
  return parseChanges(names, nums);
}

/** Patch d'un fichier d'un commit ou entre deux refs. */
export async function gitFilePatch(directory: string, target: DiffTarget, file: GitFileChange): Promise<string> {
  const paths = file.from === undefined ? [file.path] : [file.from, file.path];
  const out = await git(directory, [...diffArgs(target), '-M', '--no-color', '--', ...paths]);
  if (out === null) throw new Error(`Diff de ${file.path} illisible`);
  return out;
}

/** Commit complet (message entier). */
export async function gitCommit(directory: string, hash: string): Promise<GitCommit> {
  const out = await git(directory, ['show', '-s', `--format=${LOG_FORMAT}%x1e%B`, hash]);
  const [head = '', ...rest] = (out ?? '').split(RS);
  const commit = parseCommit(head, rest.join(RS).trim());
  if (commit === null) throw new Error(`Commit ${hash} introuvable`);
  return commit;
}

// ------------------------------------------------------------------ branches

export interface GitRef {
  /** `refs/heads/main` */
  readonly name: string;
  /** `main`, `origin/main`, `v1.0` */
  readonly short: string;
  readonly kind: 'branch' | 'remote' | 'tag';
  readonly commit: string;
  readonly date: number;
  readonly subject: string;
  readonly upstream: string;
  /** `[ahead 2, behind 1]`, `[gone]` */
  readonly track: string;
  readonly current: boolean;
  /** dossier du worktree où la branche est extraite */
  readonly worktree: string;
}

/** Branches locales, distantes et tags, les plus récents d'abord. */
export async function gitRefs(directory: string): Promise<GitRef[]> {
  const format = ['%(refname)', '%(refname:short)', '%(objectname:short)', '%(committerdate:unix)', '%(creatordate:unix)', '%(subject)', '%(upstream:short)', '%(upstream:track)', '%(HEAD)', '%(worktreepath)'].join('%1f');
  const out = await git(directory, ['for-each-ref', '--sort=-creatordate', `--format=${format}`, 'refs/heads', 'refs/remotes', 'refs/tags']);
  if (out === null) throw new Error('Branches illisibles');
  return out
    .split('\n')
    .filter((l) => l !== '')
    .map((l): GitRef => {
      const [name = '', short = '', commit = '', cdate = '', created = '0', subject = '', upstream = '', track = '', head = '', worktree = ''] = l.split(US);
      const kind = name.startsWith('refs/heads/') ? 'branch' : name.startsWith('refs/remotes/') ? 'remote' : 'tag';
      return { name, short, kind, commit, date: Number(cdate === '' ? created : cdate) * 1000, subject, upstream, track, current: head === '*', worktree };
    })
    .filter((r) => !r.name.endsWith('/HEAD'));
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
