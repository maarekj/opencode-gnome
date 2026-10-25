// Diff unifié : découpage en lignes (numéros ancien / nouveau) et sélection de lignes à commenter.
// Pur (sans GTK) : utilisé par la vue des diffs et testé à part.

const MAX_PATCH = 200_000;

export type DiffKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

export interface DiffLine {
  readonly kind: DiffKind;
  readonly text: string;
  readonly old?: number;
  readonly new?: number;
}

/** Découpe un patch unifié en lignes (sans les entêtes `diff --git`, `index`, `---`, `+++`). */
export function parsePatch(patch: string): DiffLine[] {
  const text = patch.length > MAX_PATCH ? patch.slice(0, MAX_PATCH) : patch;
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  // bloc sans position (`@@ @@`, diff reconstitué) : ni séparateur ni numéros de ligne
  let numbered = true;
  for (const line of text.split('\n')) {
    if (line === '@@ @@') {
      inHunk = true;
      numbered = false;
      continue;
    }
    if (!numbered) {
      if (line.startsWith('+')) out.push({ kind: 'add', text: line.slice(1) });
      else if (line.startsWith('-')) out.push({ kind: 'del', text: line.slice(1) });
      else if (line.startsWith(' ')) out.push({ kind: 'ctx', text: line.slice(1) });
      continue;
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/u.exec(line);
    if (h !== null) {
      oldNo = Number(h[1]);
      newNo = Number(h[3]);
      const count = Number(h[4] ?? '1');
      const range = count <= 1 ? `ligne ${newNo}` : `lignes ${newNo}–${newNo + count - 1}`;
      const context = (h[5] ?? '').trim();
      out.push({ kind: 'hunk', text: context === '' ? range : `${range} · ${context}` });
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // entêtes du fichier
    if (line.startsWith('+')) out.push({ kind: 'add', text: line.slice(1), new: newNo++ });
    else if (line.startsWith('-')) out.push({ kind: 'del', text: line.slice(1), old: oldNo++ });
    else if (line.startsWith('\\')) out.push({ kind: 'meta', text: line.slice(2) });
    else if (line.startsWith(' ')) out.push({ kind: 'ctx', text: line.slice(1), old: oldNo++, new: newNo++ });
  }
  if (patch.length > MAX_PATCH) out.push({ kind: 'meta', text: '… diff tronqué' });
  return out;
}

/** Lignes sélectionnées d'un diff (pour un commentaire de revue). */
export interface DiffSelection {
  readonly file: string;
  /** « ligne 12 », « lignes 12–15 », « ligne 4 (supprimée) » */
  readonly lines: string;
  /** lignes du diff, préfixées (+, -, espace) */
  readonly excerpt: string;
  /** dernière ligne sélectionnée (numéros nouveau / ancien) : où afficher le commentaire */
  readonly end: DiffAnchor;
}

/** Position d'une ligne d'un diff : numéro dans la nouvelle version, sinon dans l'ancienne. */
export interface DiffAnchor {
  readonly new?: number | undefined;
  readonly old?: number | undefined;
}

/** La ligne `l` est-elle celle désignée par `a` ? */
export const atAnchor = (l: DiffLine, a: DiffAnchor): boolean => (a.new === undefined ? a.old !== undefined && l.new === undefined && l.old === a.old : l.new === a.new);

const range = (ns: readonly number[]): string => {
  const a = Math.min(...ns);
  const b = Math.max(...ns);
  return a === b ? `ligne ${a}` : `lignes ${a}–${b}`;
};

/** Sélection de lignes d'un diff parsé -> extrait et plage (numéros de la nouvelle version, sinon de l'ancienne). */
export function selectionOf(file: string, lines: readonly DiffLine[], from: number, to: number): DiffSelection | null {
  const picked = lines.slice(Math.max(0, from), to + 1).filter((l) => l.kind === 'add' || l.kind === 'del' || l.kind === 'ctx');
  if (picked.length === 0) return null;
  const prefix = { add: '+', del: '-', ctx: ' ' } as const;
  const excerpt = picked.map((l) => `${prefix[l.kind === 'add' || l.kind === 'del' ? l.kind : 'ctx']}${l.text}`).join('\n');
  const lastLine = picked.at(-1);
  const end: DiffAnchor = lastLine?.new === undefined ? (lastLine?.old === undefined ? {} : { old: lastLine.old }) : { new: lastLine.new };
  const nums = picked.flatMap((l) => (l.new === undefined ? [] : [l.new]));
  if (nums.length > 0) return { file, lines: range(nums), excerpt, end };
  // uniquement des lignes supprimées : numéros de l'ancienne version
  const old = picked.flatMap((l) => (l.old === undefined ? [] : [l.old]));
  return { file, lines: old.length === 0 ? 'lignes sélectionnées' : `${range(old)} (supprimée${old.length > 1 ? 's' : ''})`, excerpt, end };
}

