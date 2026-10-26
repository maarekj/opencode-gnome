// Appel d'outil `read` : fichier lu, plage de lignes et contenu, depuis metadata.display
// (opencode récent) ou la sortie brute (<path>…<content>12: texte…</content>).
import type { ToolState } from './schemas.ts';

const field = (v: unknown, key: string): string | undefined => {
  if (typeof v !== 'object' || v === null || !(key in v)) return undefined;
  const value: unknown = Reflect.get(v, key);
  return typeof value === 'string' ? value : undefined;
};

/** Lecture d'un appel `read` : fichier lu, plage de lignes et contenu (sans l'enveloppe <path>/<content>). */
export interface ReadInfo {
  readonly path: string;
  readonly directory: boolean;
  /** « lignes 60–199 sur 255 », « 47 lignes », « dossier »… */
  readonly range: string;
  /** contenu lu, lignes numérotées ; vide s'il n'est pas encore connu */
  readonly text: string;
}

const num = (v: unknown, key: string): number | undefined => {
  if (typeof v !== 'object' || v === null) return undefined;
  const value: unknown = Reflect.get(v, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

/** Lignes numérotées à partir de `start`, numéros alignés à droite. */
function numbered(start: number, lines: readonly string[]): string {
  const width = String(start + lines.length - 1).length;
  return lines.map((l, i) => `${String(start + i).padStart(width)}  ${l}`).join('\n');
}

/** Informations d'un appel `read`, depuis metadata.display (opencode récent) ou la sortie brute. */
export function readInfo(state: ToolState | undefined): ReadInfo | null {
  const input = state?.input;
  const path = field(input, 'filePath');
  if (path === undefined || path === '') return null;
  const output = typeof state?.output === 'string' ? state.output : '';
  const directory = /^<type>directory<\/type>$/mu.test(output);
  const display: unknown = typeof state?.metadata === 'object' && state.metadata !== null ? Reflect.get(state.metadata, 'display') : undefined;
  const shown = field(display, 'text');
  const start = num(display, 'lineStart');
  const end = num(display, 'lineEnd');
  const total = num(display, 'totalLines');
  let text = '';
  let first = start;
  let last = end;
  let count = total;
  if (shown !== undefined && start !== undefined) {
    text = numbered(start, shown.replace(/\n$/u, '').split('\n'));
  } else {
    // sortie brute : contenu entre <content> et </content>, lignes « 12: texte », note finale
    // « (Showing lines 120-159 of 300…) » ou « (End of file - total 47 lines) »
    const body = /<(?:content|entries)>\n?([\s\S]*?)<\/(?:content|entries)>/u.exec(output)?.[1] ?? '';
    const showing = /\(Showing lines (\d+)-(\d+) of (\d+)/u.exec(body);
    const eof = /\(End of file - total (\d+) lines?\)/u.exec(body);
    const lines = body.replace(/\n*\((?:End of file|Showing lines|\d+ entries)[^)]*\)\s*$/u, '').replace(/\n+$/u, '').split('\n');
    const parsed = lines.map((l) => /^(\d+): ?(.*)$/u.exec(l));
    const n0 = parsed[0]?.[1];
    if (n0 !== undefined && parsed.every((m) => m !== null)) text = numbered(Number(n0), parsed.map((m) => m?.[2] ?? ''));
    else text = lines.join('\n');
    if (showing !== null) [first, last, count] = [Number(showing[1]), Number(showing[2]), Number(showing[3])];
    else if (eof !== null && n0 !== undefined) [first, last, count] = [Number(n0), Number(eof[1]), Number(eof[1])];
  }
  let range = '';
  if (directory) range = 'dossier';
  else if (first !== undefined && last !== undefined && count !== undefined) {
    range = first <= 1 && last >= count ? `${count} ligne${count > 1 ? 's' : ''}` : `lignes ${first}–${last} sur ${count}`;
  } else {
    const offset = num(input, 'offset');
    const limit = num(input, 'limit');
    if (offset !== undefined && limit !== undefined) range = `lignes ${offset}–${offset + limit - 1}`;
    else if (offset !== undefined) range = `à partir de la ligne ${offset}`;
  }
  return { path, directory, range, text };
}

