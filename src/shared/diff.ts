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


/** Bloc de modifications pour les repères de la barre de défilement (#162). */
export interface DiffMarker {
  /** première ligne et ligne suivant la dernière (indices des lignes affichées) */
  readonly start: number;
  readonly end: number;
  /** ajout seul, suppression seule, ou les deux (modification) */
  readonly kind: 'add' | 'del' | 'change';
}

/** Suites de lignes ajoutées / retirées consécutives, en blocs. */
export function diffMarkers(lines: readonly (DiffLine | null)[]): DiffMarker[] {
  const out: DiffMarker[] = [];
  let start = -1;
  let add = false;
  let del = false;
  const flush = (end: number): void => {
    if (start >= 0) out.push({ start, end, kind: add && del ? 'change' : add ? 'add' : 'del' });
    start = -1;
    add = false;
    del = false;
  };
  for (const [i, l] of lines.entries()) {
    // ligne de commentaire (null) : ne coupe pas un bloc
    if (l === null) continue;
    if (l.kind === 'add' || l.kind === 'del') {
      if (start < 0) start = i;
      if (l.kind === 'add') add = true;
      else del = true;
    } else flush(i);
  }
  flush(lines.length);
  return out;
}

/**
 * Glissière de la barre de défilement, en pixels dans la bande des repères : début et hauteur
 * de la gouttière, hauteur du curseur (souvent plus grand que la proportion de la page : taille
 * minimale).
 */
export interface ScrollTrack {
  readonly top: number;
  readonly height: number;
  readonly slider: number;
}

/**
 * Position d'un repère dans la bande, alignée sur la barre de défilement (#162) : le repère d'une
 * ligne est là où se trouve le milieu du curseur quand cette ligne est au milieu de la vue.
 * Contenu plus court que la vue (pas de défilement) : position proportionnelle.
 */
export function markerY(lineY: number, upper: number, page: number, track: ScrollTrack): number {
  if (upper <= page || page <= 0) return track.top + (lineY / Math.max(upper, page, 1)) * track.height;
  const value = Math.min(Math.max(lineY - page / 2, 0), upper - page);
  return track.top + track.slider / 2 + (value / (upper - page)) * (track.height - track.slider);
}

/** Inverse de `markerY` : position de défilement qui amène le curseur au point cliqué. */
export function valueAtMarker(y: number, upper: number, page: number, track: ScrollTrack): number {
  if (upper <= page) return 0;
  const free = track.height - track.slider;
  const f = free <= 0 ? 0 : (y - track.top - track.slider / 2) / free;
  return Math.min(Math.max(f, 0), 1) * (upper - page);
}
