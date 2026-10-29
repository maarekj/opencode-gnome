// Disposition de la barre d'un projet (#145) : terminaux persistants et liens épinglés mélangés,
// dans l'ordre choisi, rangés ou non dans des dossiers (un seul niveau). Les terminaux et les
// liens restent dans leurs listes (réglages `terminals` et `links`) ; la disposition ne contient
// que des références. Un élément absent de la disposition (créé par `ocg` ou avant elle) est
// affiché à la fin ; une référence vers un élément supprimé est ignorée.
import * as z from 'zod/mini';

export const ItemRef = z.union([z.object({ terminal: z.string() }), z.object({ link: z.string() })]);
export type ItemRef = z.output<typeof ItemRef>;

export const FolderEntry = z.object({ folder: z.string(), name: z.string(), items: z.array(ItemRef) });
export type FolderEntry = z.output<typeof FolderEntry>;

export const LayoutEntry = z.union([z.object({ terminal: z.string() }), z.object({ link: z.string() }), FolderEntry]);
export type LayoutEntry = z.output<typeof LayoutEntry>;

/** Clé d'une entrée : `terminal:id`, `link:id`, `folder:id`. */
export function keyOf(e: LayoutEntry): string {
  if ('folder' in e) return `folder:${e.folder}`;
  if ('terminal' in e) return `terminal:${e.terminal}`;
  return `link:${e.link}`;
}

/** Référence d'un terminal ou d'un lien à partir de sa clé ; null pour un dossier ou une clé invalide. */
export function refOf(key: string): ItemRef | null {
  const [kind, ...rest] = key.split(':');
  const id = rest.join(':');
  if (id === '') return null;
  if (kind === 'terminal') return { terminal: id };
  if (kind === 'link') return { link: id };
  return null;
}

const isFolder = (e: LayoutEntry): e is FolderEntry => 'folder' in e;

/**
 * Disposition complète : références orphelines et doublons retirés, éléments manquants ajoutés
 * à la fin (terminaux puis liens, dans l'ordre de leurs listes).
 */
export function normalizeLayout(layout: readonly LayoutEntry[] | undefined, terminals: readonly { id: string }[], links: readonly { id: string }[]): LayoutEntry[] {
  const known = new Set([...terminals.map((t) => `terminal:${t.id}`), ...links.map((l) => `link:${l.id}`)]);
  const seen = new Set<string>();
  const keep = (r: ItemRef): boolean => {
    const k = keyOf(r);
    if (!known.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  const out: LayoutEntry[] = [];
  for (const e of layout ?? []) {
    if (isFolder(e)) {
      if (seen.has(keyOf(e))) continue;
      seen.add(keyOf(e));
      out.push({ folder: e.folder, name: e.name, items: e.items.filter(keep) });
    } else if (keep(e)) out.push(e);
  }
  for (const t of terminals) if (keep({ terminal: t.id })) out.push({ terminal: t.id });
  for (const l of links) if (keep({ link: l.id })) out.push({ link: l.id });
  return out;
}

/** Dossier contenant l'élément `key` (null : premier niveau ou absent). */
export function folderOf(layout: readonly LayoutEntry[], key: string): string | null {
  for (const e of layout) if (isFolder(e) && e.items.some((r) => keyOf(r) === key)) return e.folder;
  return null;
}

/** Retire l'entrée `key` où qu'elle soit (premier niveau ou dossier). */
function without(layout: readonly LayoutEntry[], key: string): LayoutEntry[] {
  return layout.filter((e) => keyOf(e) !== key).map((e) => (isFolder(e) ? { folder: e.folder, name: e.name, items: e.items.filter((r) => keyOf(r) !== key) } : e));
}

/** Insère `entry` avant `before` dans `list` (à la fin si null ou absent). */
function insertBefore<T extends LayoutEntry>(list: readonly T[], entry: T, before: string | null): T[] {
  const at = before === null ? -1 : list.findIndex((e) => keyOf(e) === before);
  return at < 0 ? [...list, entry] : [...list.slice(0, at), entry, ...list.slice(at)];
}

/**
 * Déplace l'entrée `key` avant `before` (à la fin si null), au premier niveau (`folder` null) ou
 * dans le dossier `folder`. Un dossier ne va jamais dans un dossier ; dossier inconnu : rien.
 */
export function moveEntry(layout: readonly LayoutEntry[], key: string, folder: string | null, before: string | null): LayoutEntry[] {
  if (key === before) return [...layout];
  const entry = layout.find((e) => keyOf(e) === key) ?? (refOf(key) === null ? undefined : layout.filter((e) => isFolder(e)).flatMap((f) => f.items).find((r) => keyOf(r) === key));
  if (entry === undefined) return [...layout];
  if (folder === null) return insertBefore(without(layout, key), entry, before);
  const ref = refOf(key);
  if (ref === null || !layout.some((e) => isFolder(e) && e.folder === folder)) return [...layout];
  return without(layout, key).map((e) => (isFolder(e) && e.folder === folder ? { folder: e.folder, name: e.name, items: insertBefore(e.items, ref, before) } : e));
}

/** Nouveau dossier à la fin. */
export function addFolder(layout: readonly LayoutEntry[], id: string, name: string): LayoutEntry[] {
  return [...layout, { folder: id, name, items: [] }];
}

export function renameFolder(layout: readonly LayoutEntry[], id: string, name: string): LayoutEntry[] {
  return layout.map((e) => (isFolder(e) && e.folder === id ? { folder: e.folder, name, items: e.items } : e));
}

/** Supprime un dossier : son contenu reprend sa place, au premier niveau. */
export function removeFolder(layout: readonly LayoutEntry[], id: string): LayoutEntry[] {
  return layout.flatMap((e) => (isFolder(e) && e.folder === id ? e.items : [e]));
}

/** Dossier désigné par son identifiant ou son nom. */
export function findFolder(layout: readonly LayoutEntry[], ref: string): FolderEntry | undefined {
  const folders = layout.filter((e) => isFolder(e));
  return folders.find((f) => f.folder === ref) ?? folders.find((f) => f.name === ref);
}

/** Identifiant libre pour un nouveau dossier. */
export function folderId(layout: readonly LayoutEntry[], seed = Date.now()): string {
  const taken = new Set(layout.filter((e) => isFolder(e)).map((f) => f.folder));
  let id = `f${seed.toString(36)}`;
  while (taken.has(id)) id += 'x';
  return id;
}
