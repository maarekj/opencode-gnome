// Hiérarchie des projets de la barre latérale : un projet dont le dossier est dans celui d'un
// autre projet est rangé sous son ancêtre le plus proche (parmi les projets affichés).

export interface ProjectNode {
  readonly path: string;
  /** chemin du projet parent, null au premier niveau */
  readonly parent: string | null;
  readonly depth: number;
}

const inside = (path: string, dir: string): boolean => dir !== path && (dir === '/' ? path.startsWith('/') : path.startsWith(`${dir}/`));

/** Ancêtre le plus proche de `path` parmi `paths`, ou null. */
export function parentOf(path: string, paths: readonly string[]): string | null {
  let best: string | null = null;
  for (const p of paths) if (inside(path, p) && (best === null || p.length > best.length)) best = p;
  return best;
}

/** Projets dont le dossier est dans celui de `path` (tous niveaux), parmi `paths`. */
export const descendantsOf = (path: string, paths: readonly string[]): string[] => paths.filter((p) => inside(p, path));

/**
 * Ordre d'affichage : premier niveau dans l'ordre de `paths`, chaque projet suivi de ses
 * sous-projets. Entre frères, l'ordre de `order[parent]` (glisser-déposer) prime ; les autres
 * suivent dans l'ordre de `paths`.
 */
export function projectTree(paths: readonly string[], order: Readonly<Record<string, readonly string[]>> = {}): ProjectNode[] {
  const unique = [...new Set(paths)];
  const parent = new Map(unique.map((p) => [p, parentOf(p, unique)]));
  const children = new Map<string | null, string[]>();
  for (const p of unique) {
    const key = parent.get(p) ?? null;
    const list = children.get(key) ?? [];
    list.push(p);
    children.set(key, list);
  }
  const sorted = (key: string | null): string[] => {
    const list = children.get(key) ?? [];
    if (key === null) return list;
    const wanted = order[key] ?? [];
    const rank = (p: string): number => {
      const i = wanted.indexOf(p);
      return i === -1 ? wanted.length + list.indexOf(p) : i;
    };
    return list.toSorted((a, b) => rank(a) - rank(b));
  };
  const out: ProjectNode[] = [];
  const walk = (key: string | null, depth: number): void => {
    for (const p of sorted(key)) {
      out.push({ path: p, parent: key, depth });
      walk(p, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Ordre des sous-projets de `parent` après déplacement de `item` avant `before` (fin si null). */
export function moveChild(siblings: readonly string[], item: string, before: string | null): string[] {
  const rest = siblings.filter((p) => p !== item);
  const at = before === null ? -1 : rest.indexOf(before);
  return at < 0 ? [...rest, item] : [...rest.slice(0, at), item, ...rest.slice(at)];
}
