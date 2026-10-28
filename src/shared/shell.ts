// Découpage d'une commande shell pour l'affichage (#143) : étapes reliées par &&, ||, ;, |, &,
// retours à la ligne, et mots de chaque commande (nom, options, chaînes, redirections, heredocs).
// Ce n'est pas un interpréteur : les guillemets, échappements, $(…), `…`, ${…}, sous-shells
// ( … ) et blocs { … } sont seulement reconnus pour ne pas couper à l'intérieur.

export type WordKind = 'command' | 'assign' | 'option' | 'string' | 'word' | 'redirect' | 'heredoc' | 'comment' | 'group';

export interface Word {
  readonly kind: WordKind;
  /** texte source du mot (guillemets compris) ; heredoc : corps et délimiteur de fin */
  readonly text: string;
}

/** Opérateur qui relie une étape à la précédente ('' : première étape ou retour à la ligne). */
export type Connector = '' | '&&' | '||' | ';' | '|' | '|&' | '&';

export interface Step {
  readonly op: Connector;
  readonly words: readonly Word[];
}

const PREFIXES = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', '!', 'exec', 'sudo', 'env', 'nohup', 'command', 'builtin']);

const OPERATORS = ['&&', '||', '|&', ';;', ';', '|', '&'] as const;

const operatorAt = (s: string, i: number): (typeof OPERATORS)[number] | undefined => OPERATORS.find((o) => s.startsWith(o, i));

/** Fin d'une substitution ou d'un groupe ouvert en `i` (après l'ouvrant), guillemets compris. */
function skipNested(s: string, i: number, close: string): number {
  const open = close === ')' ? '(' : close === '}' ? '{' : '';
  let depth = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') i += 2;
    else if (c === "'") i = skipSingle(s, i + 1);
    else if (c === '"') i = skipDouble(s, i + 1);
    else if (c === '`') i = skipBacktick(s, i + 1);
    else if (c === '$' && s[i + 1] === '(') i = skipNested(s, i + 2, ')');
    else if (c === '$' && s[i + 1] === '{') i = skipNested(s, i + 2, '}');
    else if (open !== '' && c === open) {
      depth += 1;
      i += 1;
    } else if (c === close) {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
    } else i += 1;
  }
  throw new SyntaxError(`« ${close} » manquant`);
}

function skipSingle(s: string, i: number): number {
  const end = s.indexOf("'", i);
  if (end < 0) throw new SyntaxError('apostrophe non fermée');
  return end + 1;
}

function skipDouble(s: string, i: number): number {
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') i += 2;
    else if (c === '"') return i + 1;
    else if (c === '`') i = skipBacktick(s, i + 1);
    else if (c === '$' && s[i + 1] === '(') i = skipNested(s, i + 2, ')');
    else if (c === '$' && s[i + 1] === '{') i = skipNested(s, i + 2, '}');
    else i += 1;
  }
  throw new SyntaxError('guillemet non fermé');
}

function skipBacktick(s: string, i: number): number {
  while (i < s.length) {
    if (s[i] === '\\') i += 2;
    else if (s[i] === '`') return i + 1;
    else i += 1;
  }
  throw new SyntaxError('accent grave non fermé');
}

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t';
const isBreak = (c: string | undefined): boolean => c === undefined || isSpace(c) || c === '\n' || c === ';' || c === '&' || c === '|' || c === '<' || c === '>' || c === '(' || c === ')';

/** Redirection commençant en `i` (`2>&1`, `>>`, `&>`, `<<<`, `<<-`…), ou null. */
const REDIRECT = /\d*>>|\d*>&\d*-?|\d*<&\d*-?|&>>?|\d*<<<|\d*<<-?|\d*<>|\d*>\||\d*[<>]/uy;

function redirectAt(s: string, i: number): string | null {
  // expression collante : pas de copie de la fin de la commande à chaque mot
  REDIRECT.lastIndex = i;
  return REDIRECT.exec(s)?.[0] ?? null;
}

/** Lit un mot à partir de `i` : fin du mot. */
function wordEnd(s: string, i: number): number {
  while (i < s.length && !isBreak(s[i])) {
    const c = s[i];
    if (c === '\\') i += 2;
    else if (c === "'") i = skipSingle(s, i + 1);
    else if (c === '"') i = skipDouble(s, i + 1);
    else if (c === '`') i = skipBacktick(s, i + 1);
    else if (c === '$' && s[i + 1] === '(') i = skipNested(s, i + 2, ')');
    else if (c === '$' && s[i + 1] === '{') i = skipNested(s, i + 2, '}');
    else i += 1;
  }
  return Math.min(i, s.length);
}

/** Délimiteur d'un heredoc tel qu'écrit (`EOF`, `'EOF'`, `"EOF"`) → délimiteur de fin. */
const heredocDelimiter = (raw: string): string => raw.replaceAll(/['"\\]/gu, '');

function classify(text: string, isFirst: boolean): WordKind {
  if (isFirst && /^[A-Za-z_][A-Za-z0-9_]*\+?=/u.test(text)) return 'assign';
  if (isFirst) return 'command';
  if (text.startsWith('-')) return 'option';
  if (/^["'$]/u.test(text) || /^[^'"]*=["']/u.test(text)) return 'string';
  return 'word';
}

/**
 * Découpe `command` en étapes ; exception SyntaxError si elle est mal formée (guillemet non
 * fermé…) : l'appelant affiche alors la commande brute.
 */
export function parseShell(command: string): Step[] {
  const s = command;
  const steps: Step[] = [];
  let words: Word[] = [];
  let op: Connector = '';
  /** heredocs en attente : leur corps commence à la ligne suivante */
  let pending: { delimiter: string; strip: boolean; target: Word[] }[] = [];
  /** le prochain mot ordinaire est-il le nom de la commande ? */
  let first = true;
  const endStep = (next: Connector): void => {
    if (words.length > 0) steps.push({ op, words });
    words = [];
    op = next;
    first = true;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i] ?? '';
    if (isSpace(c)) {
      i += 1;
      continue;
    }
    if (c === '\\' && s[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '\n') {
      i += 1;
      // corps des heredocs ouverts sur la ligne qui se termine
      for (const h of pending) {
        const lines: string[] = [];
        let found = false;
        while (i <= s.length) {
          const nl = s.indexOf('\n', i);
          const line = s.slice(i, nl < 0 ? s.length : nl);
          i = nl < 0 ? s.length + 1 : nl + 1;
          if ((h.strip ? line.replace(/^\t+/u, '') : line) === h.delimiter) {
            found = true;
            break;
          }
          lines.push(line);
          if (nl < 0) break;
        }
        i = Math.min(i, s.length);
        h.target.push({ kind: 'heredoc', text: lines.join('\n') + (found ? `\n${h.delimiter}` : '') });
      }
      pending = [];
      endStep('');
      continue;
    }
    if (c === '#' && (i === 0 || isBreak(s[i - 1]))) {
      const nl = s.indexOf('\n', i);
      const end = nl < 0 ? s.length : nl;
      words.push({ kind: 'comment', text: s.slice(i, end) });
      i = end;
      continue;
    }
    const red = redirectAt(s, i);
    if (red !== null) {
      i += red.length;
      while (isSpace(s[i])) i += 1;
      // cible : un mot (sauf 2>&1, >&- … qui la contiennent déjà)
      let target = '';
      if (!/&\d*-?$/u.test(red) || red.startsWith('&')) {
        const end = wordEnd(s, i);
        target = s.slice(i, end);
        i = end;
      }
      words.push({ kind: 'redirect', text: target === '' ? red : `${red} ${target}` });
      if (/(?<!<)<<-?$/u.test(red) && target !== '') pending.push({ delimiter: heredocDelimiter(target), strip: red.endsWith('-'), target: words });
      continue;
    }
    const operator = operatorAt(s, i);
    if (operator !== undefined) {
      i += operator.length;
      endStep(operator === ';;' ? ';' : operator);
      continue;
    }
    if (c === '(' || (c === '{' && isBreak(s[i + 1]))) {
      // sous-shell ou bloc : un seul mot, non découpé
      const end = skipNested(s, i + 1, c === '(' ? ')' : '}');
      words.push({ kind: 'group', text: s.slice(i, end) });
      first = false;
      i = end;
      continue;
    }
    if (c === ')') throw new SyntaxError('« ) » inattendue');
    const end = wordEnd(s, i);
    const text = s.slice(i, end);
    // options d'un préfixe (sudo -E…) : la commande vient encore après
    const prefixOption: boolean = first && words.length > 0 && text.startsWith('-');
    const kind: WordKind = prefixOption ? 'option' : classify(text, first);
    // affectations, mots-clés et préfixes (sudo, env…) : la commande vient après
    first = prefixOption || kind === 'assign' || (kind === 'command' && PREFIXES.has(text));
    words.push({ kind, text });
    i = end;
  }
  if (pending.length > 0) for (const h of pending) h.target.push({ kind: 'heredoc', text: '' });
  endStep('');
  return steps;
}

/** Mot long (message, script) : replié dans l'affichage. */
export const isLong = (w: Word, max = 60): boolean => w.text.length > max || w.text.includes('\n');

/** Version abrégée d'un mot long : première ligne, coupée, guillemet fermant conservé. */
export function abbreviate(w: Word, max = 40): string {
  const line = w.text.split('\n')[0] ?? '';
  const quote = /^["']/u.exec(w.text)?.[0] ?? '';
  const cut = line.length > max ? line.slice(0, max) : line;
  return `${cut}…${quote !== '' && cut.length < w.text.length ? quote : ''}`;
}
