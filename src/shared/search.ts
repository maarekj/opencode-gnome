// Recherche dans toutes les conversations. opencode n'a pas d'API de recherche : index local
// (~/.cache/opencode-gnome/search-<serveur>.json) du texte des messages (utilisateur et
// assistant) et des titres des sessions principales, mis à jour par session quand elle change
// (date de mise à jour plus récente que celle indexée).
import GLib from 'gi://GLib';
import * as z from 'zod/mini';
import type { OpencodeClient } from './client.ts';

/** Un texte indexé : une partie `text` d'un message. */
export interface IndexedText {
  readonly message: string;
  readonly part: string;
  readonly role: 'user' | 'assistant';
  readonly created: number;
  readonly text: string;
}

export interface IndexedSession {
  readonly id: string;
  readonly title: string;
  readonly directory: string;
  readonly projectID: string;
  readonly updated: number;
  readonly texts: readonly IndexedText[];
}

const IndexFile = z.object({
  version: z.literal(1),
  sessions: z.record(
    z.string(),
    z.object({
      id: z.string(),
      title: z.string(),
      directory: z.string(),
      projectID: z.string(),
      updated: z.number(),
      texts: z.array(z.object({ message: z.string(), part: z.string(), role: z.enum(['user', 'assistant']), created: z.number(), text: z.string() })),
    }),
  ),
});

/** Texte comparable : minuscules, sans accents. */
export const fold = (s: string): string => s.normalize('NFD').replaceAll(/\p{Diacritic}/gu, '').toLowerCase();

/** Termes d'une requête (tous doivent apparaître). */
export const terms = (query: string): string[] =>
  fold(query)
    .split(/\s+/u)
    .filter((t) => t !== '');

export interface SearchFilter {
  /** clé de projet (identifiant opencode, ou `dir:<chemin>` hors git) */
  readonly project?: string | undefined;
  /** messages postérieurs à cette date (ms) */
  readonly since?: number | undefined;
}

export interface SearchHit {
  readonly session: IndexedSession;
  /** null : le titre de la session correspond */
  readonly text: IndexedText | null;
  /** extrait autour de la première occurrence */
  readonly snippet: string;
}

/** Extrait de `text` autour de la première occurrence d'un terme (≈ `width` caractères). */
export function snippetOf(text: string, query: readonly string[], width = 160): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim();
  const folded = fold(flat);
  const first = Math.min(...query.map((t) => folded.indexOf(t)).filter((i) => i >= 0));
  const at = Number.isFinite(first) ? first : 0;
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** Plages [début, fin[ des termes dans `text` (pour la mise en évidence). */
export function matchRanges(text: string, query: readonly string[]): [number, number][] {
  const folded = fold(text);
  const out: [number, number][] = [];
  for (const t of query) {
    for (let i = folded.indexOf(t); i >= 0; i = folded.indexOf(t, i + t.length)) out.push([i, i + t.length]);
  }
  return out.toSorted((a, b) => a[0] - b[0]);
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Textes d'une réponse `GET /session/:id/message` (parties `text` non synthétiques). */
export function textsOf(messages: unknown): IndexedText[] {
  if (!Array.isArray(messages)) return [];
  const out: IndexedText[] = [];
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) continue;
    const info: unknown = Reflect.get(m, 'info');
    const parts: unknown = Reflect.get(m, 'parts');
    if (typeof info !== 'object' || info === null || !Array.isArray(parts)) continue;
    const role: unknown = Reflect.get(info, 'role');
    const id: unknown = Reflect.get(info, 'id');
    const time: unknown = Reflect.get(info, 'time');
    const created: unknown = typeof time === 'object' && time !== null ? Reflect.get(time, 'created') : 0;
    if ((role !== 'user' && role !== 'assistant') || typeof id !== 'string') continue;
    for (const p of parts) {
      if (typeof p !== 'object' || p === null) continue;
      const text: unknown = Reflect.get(p, 'text');
      const pid: unknown = Reflect.get(p, 'id');
      if (Reflect.get(p, 'type') !== 'text' || Reflect.get(p, 'synthetic') === true || typeof text !== 'string' || typeof pid !== 'string' || text.trim() === '') continue;
      out.push({ message: id, part: pid, role, created: typeof created === 'number' ? created : 0, text });
    }
  }
  return out;
}

export class SearchIndex {
  readonly #client: OpencodeClient;
  readonly #path: string;
  readonly #sessions = new Map<string, IndexedSession>();
  /** textes repliés (minuscules, sans accents), calculés à la demande */
  readonly #folded = new WeakMap<object, string>();
  #loaded = false;
  #refreshing: Promise<void> | null = null;
  #again = false;

  constructor(client: OpencodeClient, path?: string) {
    this.#client = client;
    const server = client.url.replace(/^https?:\/\//u, '').replaceAll(/[^\w.-]+/gu, '_');
    this.#path = path ?? GLib.build_filenamev([GLib.get_user_cache_dir(), 'opencode-gnome', `search-${server}.json`]);
  }

  get size(): number {
    return this.#sessions.size;
  }

  #load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const [ok, bytes] = GLib.file_get_contents(this.#path);
      if (!ok) return;
      const parsed = IndexFile.safeParse(JSON.parse(decoder.decode(bytes)));
      if (!parsed.success) return; // ancien format ou fichier abîmé : reconstruit
      for (const s of Object.values(parsed.data.sessions)) this.#sessions.set(s.id, s);
    } catch {
      // absent
    }
  }

  #save(): void {
    try {
      GLib.mkdir_with_parents(GLib.path_get_dirname(this.#path), 0o700);
      GLib.file_set_contents(this.#path, encoder.encode(JSON.stringify({ version: 1, sessions: Object.fromEntries(this.#sessions) })));
    } catch (e) {
      console.error(`index de recherche non enregistré : ${String(e)}`);
    }
  }

  /**
   * Met l'index à jour : sessions nouvelles ou modifiées relues (3 à la fois), sessions
   * supprimées retirées. `progress(fait, total)` pendant la relecture. Un appel pendant une mise
   * à jour en relance une à la fin.
   */
  refresh(progress?: (done: number, total: number) => void): Promise<void> {
    this.#load();
    if (this.#refreshing !== null) {
      this.#again = true;
      return this.#refreshing;
    }
    const run = async (): Promise<void> => {
      do {
        this.#again = false;
        // oxlint-disable-next-line no-await-in-loop -- mises à jour successives
        await this.#update(progress);
      } while (this.#again);
    };
    this.#refreshing = run().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #update(progress?: (done: number, total: number) => void): Promise<void> {
    const sessions = await this.#client.sessions(100_000);
    const alive = new Set(sessions.map((s) => s.id));
    let changed = false;
    for (const id of this.#sessions.keys()) {
      if (alive.has(id)) continue;
      this.#sessions.delete(id);
      changed = true;
    }
    const todo = sessions.filter((s) => {
      const known = this.#sessions.get(s.id);
      const updated = s.time.updated ?? s.time.created;
      if (known !== undefined && known.updated >= updated) {
        // titre renommé sans nouveau message
        if (known.title !== s.title) this.#sessions.set(s.id, { ...known, title: s.title });
        return false;
      }
      return true;
    });
    let done = 0;
    progress?.(0, todo.length);
    const worker = async (): Promise<void> => {
      for (let s = todo.shift(); s !== undefined; s = todo.shift()) {
        const session = s;
        try {
          // oxlint-disable-next-line no-await-in-loop -- relecture séquentielle par ouvrier
          const raw = await this.#client.request('GET', `/session/${encodeURIComponent(session.id)}/message`, z.unknown(), { query: { limit: 100_000 } });
          this.#sessions.set(session.id, {
            id: session.id,
            title: session.title,
            directory: session.directory,
            projectID: session.projectID,
            updated: session.time.updated ?? session.time.created,
            texts: textsOf(raw),
          });
          changed = true;
        } catch {
          // session supprimée entre-temps, serveur occupé… : relue à la prochaine mise à jour
        }
        done += 1;
        progress?.(done, done + todo.length);
        if (done % 25 === 0) this.#save();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (changed) this.#save();
  }

  #fold(o: object, text: string): string {
    let f = this.#folded.get(o);
    if (f === undefined) {
      f = fold(text);
      this.#folded.set(o, f);
    }
    return f;
  }

  /** Résultats, du plus récent au plus ancien (au plus `limit`). */
  search(query: string, filter: SearchFilter = {}, limit = 200): SearchHit[] {
    this.#load();
    const q = terms(query);
    if (q.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const s of this.#sessions.values()) {
      if (filter.project !== undefined && filter.project !== s.projectID && filter.project !== `dir:${s.directory}`) continue;
      const title = this.#fold(s, s.title);
      if (q.every((t) => title.includes(t)) && (filter.since === undefined || s.updated >= filter.since)) {
        hits.push({ session: s, text: null, snippet: s.title });
      }
      for (const x of s.texts) {
        if (filter.since !== undefined && x.created < filter.since) continue;
        const folded = this.#fold(x, x.text);
        if (q.every((t) => folded.includes(t))) hits.push({ session: s, text: x, snippet: snippetOf(x.text, q) });
      }
    }
    const date = (h: SearchHit): number => h.text?.created ?? h.session.updated;
    return hits.toSorted((a, b) => date(b) - date(a)).slice(0, limit);
  }
}
