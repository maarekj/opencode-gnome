// Arborescence d'une liste de fichiers modifiés (fenêtre git) : dossiers puis fichiers, triés,
// chaînes de dossiers à un seul sous-dossier fusionnées (`src/app`), comme les éditeurs.

export interface TreeFile {
  readonly path: string;
  readonly additions: number | null;
  readonly deletions: number | null;
}

export type TreeRow<F extends TreeFile> =
  | { readonly kind: 'dir'; readonly path: string; readonly label: string; readonly depth: number; readonly files: number; readonly additions: number; readonly deletions: number }
  | { readonly kind: 'file'; readonly file: F; readonly label: string; readonly depth: number };

interface Node<F> {
  readonly dirs: Map<string, Node<F>>;
  readonly files: F[];
}

const node = <F>(): Node<F> => ({ dirs: new Map(), files: [] });

function stats<F extends TreeFile>(n: Node<F>): { files: number; additions: number; deletions: number } {
  let files = n.files.length;
  let additions = n.files.reduce((s, f) => s + (f.additions ?? 0), 0);
  let deletions = n.files.reduce((s, f) => s + (f.deletions ?? 0), 0);
  for (const d of n.dirs.values()) {
    const s = stats(d);
    files += s.files;
    additions += s.additions;
    deletions += s.deletions;
  }
  return { files, additions, deletions };
}

/**
 * Lignes de l'arborescence, dans l'ordre d'affichage. `collapsed` : chemins de dossiers repliés
 * (leur contenu est omis).
 */
export function fileTree<F extends TreeFile>(files: readonly F[], collapsed: ReadonlySet<string> = new Set()): TreeRow<F>[] {
  const root = node<F>();
  for (const f of files) {
    const parts = f.path.split('/');
    let n = root;
    for (const part of parts.slice(0, -1)) {
      let next = n.dirs.get(part);
      if (next === undefined) {
        next = node<F>();
        n.dirs.set(part, next);
      }
      n = next;
    }
    n.files.push(f);
  }
  const rows: TreeRow<F>[] = [];
  const walk = (n: Node<F>, prefix: string, depth: number): void => {
    for (const [name, child] of [...n.dirs.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
      // fusion : dossier sans fichier et avec un seul sous-dossier
      let label = name;
      let target = child;
      for (;;) {
        const only = target.files.length === 0 && target.dirs.size === 1 ? [...target.dirs.entries()][0] : undefined;
        if (only === undefined) break;
        label = `${label}/${only[0]}`;
        target = only[1];
      }
      const path = prefix === '' ? label : `${prefix}/${label}`;
      rows.push({ kind: 'dir', path, label, depth, ...stats(target) });
      if (!collapsed.has(path)) walk(target, path, depth + 1);
    }
    for (const f of n.files.toSorted((a, b) => a.path.localeCompare(b.path))) rows.push({ kind: 'file', file: f, label: f.path.slice(f.path.lastIndexOf('/') + 1), depth });
  };
  walk(root, '', 0);
  return rows;
}
