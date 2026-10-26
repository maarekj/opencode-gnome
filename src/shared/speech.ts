// Texte à lire à voix haute : markdown nettoyé (code, liens, tableaux, emphase…) et découpé en
// morceaux pour la synthèse (lecture qui commence vite, limite de taille des API).

/** Markdown -> texte lisible : un paragraphe par ligne. */
export function speakable(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    const open = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (fence !== null) {
      if (open?.[1] !== undefined && open[1][0] === fence[0] && open[1].length >= fence.length && line.trim() === open[1]) fence = null;
      continue;
    }
    if (open?.[1] !== undefined) {
      fence = open[1];
      out.push('(bloc de code)');
      continue;
    }
    // séparateurs : ligne horizontale, ligne d'alignement d'un tableau
    if (/^\s*([-*_]\s*){3,}$/u.test(line) || /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/u.test(line)) continue;
    let text = line;
    // ligne de tableau : cellules séparées par des virgules
    if (/^\s*\|.*\|\s*$/u.test(text))
      text = text
        .trim()
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim())
        .filter((c) => c !== '')
        .join(', ');
    text = text
      .replace(/^\s*#{1,6}\s+(.*?)\s*#*$/u, (_m, t: string) => (/[.!?:]$/u.test(t) ? t : `${t}.`))
      .replace(/^\s*(>\s*)+/u, '')
      .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/u, '')
      .replaceAll(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replaceAll(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
      .replaceAll(/<(https?:\/\/[^>]+)>/gu, 'lien')
      .replaceAll(/https?:\/\/\S+/gu, 'lien')
      .replaceAll(/<\/?[a-zA-Z][^>]*>/gu, '')
      .replaceAll(/`([^`]*)`/gu, '$1')
      .replaceAll(/(\*\*|__)(.+?)\1/gu, '$2')
      .replaceAll(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?!\w)/gu, '$1$2')
      .replaceAll(/~~(.+?)~~/gu, '$1')
      .replaceAll(/\s+/gu, ' ')
      .trim();
    if (text === '') {
      if (out.at(-1) !== '') out.push('');
      continue;
    }
    // lignes d'un même paragraphe réunies
    const prev = out.at(-1);
    if (prev !== undefined && prev !== '' && prev !== '(bloc de code)' && !/^\s*([-*+]|\d+[.)])\s/u.test(raw) && !/^\s*\|/u.test(raw) && !/^\s*#/u.test(raw)) out[out.length - 1] = `${prev} ${text}`;
    else out.push(text);
  }
  return out
    .filter((l) => l !== '')
    .join('\n')
    .trim();
}

/** Découpe en morceaux d'au plus `max` caractères, aux fins de paragraphe puis de phrase. */
export function chunks(text: string, max = 600): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let rest = para.trim();
    while (rest.length > max) {
      const head = rest.slice(0, max);
      const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('; '));
      const at = cut > max / 3 ? cut + 1 : head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : max;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest !== '') out.push(rest);
  }
  return out;
}

/** Chemin d'une voix Piper dans rhasspy/piper-voices (`fr_FR-siwis-medium` -> `fr/fr_FR/siwis/medium/…`). */
export function piperVoicePath(voice: string): string | null {
  const m = /^(([a-z]{2,3})_[A-Z]{2})-([\w]+)-(x_low|low|medium|high)$/u.exec(voice);
  if (m === null) return null;
  return `${m[2]}/${m[1]}/${m[3]}/${m[4]}/${voice}`;
}

/** Fichier WAV (PCM 16 bits, mono) autour d'échantillons bruts. */
export function wavFile(pcm: Uint8Array, rate = 16000): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.codePointAt(i) ?? 0;
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}
