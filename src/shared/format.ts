import GLib from 'gi://GLib';

export const esc = (s: string): string => GLib.markup_escape_text(s, -1);

/** « à l'instant », « il y a 5 min », « hier », « 12 oct. » */
export function fmtRelative(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "à l'instant";
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  if (d === 1) return 'hier';
  if (d < 7) return `il y a ${d} j`;
  return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: d > 300 ? 'numeric' : undefined });
}

export const fmtCost = (usd: number | undefined): string => (usd === undefined || usd === 0 ? '' : `${usd.toFixed(2)} $`);
