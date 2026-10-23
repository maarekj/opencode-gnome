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

const dayOf = (x: GLib.DateTime): string => x.format('%Y-%m-%d') ?? '';

/** Heure d'un message : « 14:32 », « hier 14:32 », « 12 oct. 14:32 », « 12 oct. 2025 14:32 ». */
export function fmtStamp(ms: number, now = Date.now()): string {
  const d = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
  const today = GLib.DateTime.new_from_unix_local(Math.floor(now / 1000));
  const time = d.format('%H:%M') ?? '';
  if (dayOf(d) === dayOf(today)) return time;
  if (dayOf(d) === dayOf(today.add_days(-1) ?? today)) return `hier ${time}`;
  const date = new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', ...(d.get_year() === today.get_year() ? {} : { year: 'numeric' }) });
  return `${date} ${time}`;
}

/** Date complète (infobulle). */
export const fmtFullDate = (ms: number): string =>
  new Date(ms).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Durée : « 0,9 s », « 13 s », « 1 min 05 s », « 1 h 02 min ». */
export function fmtDuration(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1).replace('.', ',')} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
