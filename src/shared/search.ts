// Recherche dans toutes les conversations. opencode n'a pas d'API de recherche : index local
// SQLite (~/.cache/opencode-gnome/search-<serveur>.db, libgda) du texte des messages
// (utilisateur et assistant) et des titres des sessions principales, mis à jour par session quand
// elle change (date de mise à jour plus récente que celle indexée). Table plein texte FTS5 avec
// le tokenizer `trigram` : recherche en milieu de mot, sans casse ni accents (#130).
import type GdaNs from 'gi://Gda?version=6.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type { OpencodeClient } from './client.ts';

/** libgda est optionnel : sans lui, la recherche est indisponible (message explicite). */
let Gda: typeof GdaNs | null = null;
try {
  Gda = (await import('gi://Gda?version=6.0')).default;
} catch (e) {
  console.warn(`recherche indisponible (libgda 6) : ${String(e)}`);
}

export const searchAvailable = (): boolean => Gda !== null;

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
}

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

const hexEncoder = new TextEncoder();
/**
 * Littéral SQL d'une chaîne, en hexadécimal (UTF-8) : ni apostrophe ni barre oblique inverse
 * dans la requête. Le délimiteur de libgda prend `\'` pour une apostrophe échappée et plante
 * (free invalide) sur un texte qui en contient, fréquent dans les messages (code, chemins).
 */
const lit = (s: string): string => `CAST(X'${Array.from(hexEncoder.encode(s), (b) => b.toString(16).padStart(2, '0')).join('')}' AS TEXT)`;
/** Entier SQL. */
const num = (n: number): string => String(Math.trunc(n));
/** Terme FTS5 entre guillemets (recherche littérale). */
const phrase = (s: string): string => `"${s.replaceAll('"', '""')}"`;
/** Le tokenizer trigram ne sait chercher que des termes de 3 caractères ou plus. */
const TRIGRAM = 3;

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)',
  'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, directory TEXT, project TEXT, updated INTEGER)',
  // une ligne par texte : role « title » pour le titre de la session
  "CREATE VIRTUAL TABLE IF NOT EXISTS texts USING fts5(body, session UNINDEXED, message UNINDEXED, part UNINDEXED, role UNINDEXED, created UNINDEXED, tokenize='trigram remove_diacritics 1')",
];
const VERSION = '1';

export class SearchIndex {
  readonly #client: OpencodeClient;
  readonly #dir: string;
  readonly #name: string;
  #db: GdaNs.Connection | null = null;
  #parser: GdaNs.SqlParser | null = null;
  #refreshing: Promise<void> | null = null;
  #again = false;

  /** `path` : fichier de la base (sans extension .db ajoutée par libgda) */
  constructor(client: OpencodeClient, path?: string) {
    this.#client = client;
    const server = client.url.replace(/^https?:\/\//u, '').replaceAll(/[^\w.-]+/gu, '_');
    const base = path ?? GLib.build_filenamev([GLib.get_user_cache_dir(), 'opencode-gnome', `search-${server}`]);
    this.#dir = GLib.path_get_dirname(base);
    this.#name = GLib.path_get_basename(base);
  }

  /** Base ouverte (créée au besoin) ; lève une erreur si libgda est absent. */
  #open(): GdaNs.Connection {
    if (this.#db !== null) return this.#db;
    if (Gda === null) throw new Error('recherche indisponible : bibliothèque libgda 6 introuvable');
    GLib.mkdir_with_parents(this.#dir, 0o700);
    // ancien index JSON (#126) : remplacé
    try {
      Gio.File.new_for_path(GLib.build_filenamev([this.#dir, `${this.#name}.json`])).delete(null);
    } catch {
      // absent
    }
    const db = Gda.Connection.open_from_string('SQLite', `DB_DIR=${this.#dir};DB_NAME=${this.#name}`, null, Gda.ConnectionOptions.NONE);
    let version: string | null = null;
    try {
      version = this.#strings(db, "SELECT value FROM meta WHERE key = 'version'")[0]?.[0] ?? null;
    } catch {
      // base neuve
    }
    if (version !== VERSION) for (const t of ['texts', 'sessions', 'meta']) this.#exec(db, `DROP TABLE IF EXISTS ${t}`);
    for (const sql of SCHEMA) this.#exec(db, sql);
    this.#exec(db, `INSERT OR REPLACE INTO meta (key, value) VALUES ('version', ${lit(VERSION)})`);
    this.#db = db;
    return db;
  }

  /**
   * Lignes d'une requête, colonnes converties en chaînes (null : NULL). Les entiers au-delà de
   * 32 bits (dates en ms) doivent être lus en texte (`CAST(… AS TEXT)`) : libgda refuse sinon.
   */
  #strings(db: GdaNs.Connection, sql: string): (string | null)[][] {
    const model = db.statement_execute_select(this.#statement(db, sql), null);
    const rows: (string | null)[][] = [];
    const cols = model.get_n_columns();
    for (let r = 0; r < model.get_n_rows(); r += 1) {
      const row: (string | null)[] = [];
      for (let c = 0; c < cols; c += 1) {
        const v: unknown = model.get_value_at(c, r);
        row.push(typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean' ? String(v) : null);
      }
      rows.push(row);
    }
    return rows;
  }

  /** Nombre de sessions indexées. */
  get size(): number {
    return Number(this.#strings(this.#open(), 'SELECT count(*) FROM sessions')[0]?.[0] ?? 0);
  }

  /**
   * Met l'index à jour : sessions nouvelles ou modifiées relues (3 à la fois), sessions
   * supprimées retirées. `progress(fait, total)` pendant la relecture. Un appel pendant une mise
   * à jour en relance une à la fin.
   */
  refresh(progress?: (done: number, total: number) => void): Promise<void> {
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
    const db = this.#open();
    const sessions = await this.#client.sessions(100_000);
    const indexed = new Map(this.#strings(db, 'SELECT id, title, CAST(updated AS TEXT) FROM sessions').map(([id, title, updated]) => [id ?? '', { title: title ?? '', updated: Number(updated ?? 0) }]));
    const alive = new Set(sessions.map((s) => s.id));
    // sessions supprimées
    const gone = [...indexed.keys()].filter((id) => !alive.has(id));
    if (gone.length > 0) {
      const ids = gone.map((id) => lit(id)).join(',');
      this.#transaction(db, [`DELETE FROM texts WHERE session IN (${ids})`, `DELETE FROM sessions WHERE id IN (${ids})`]);
    }
    const todo = sessions.filter((s) => {
      const known = indexed.get(s.id);
      const updated = s.time.updated ?? s.time.created;
      if (known !== undefined && known.updated >= updated) {
        // titre renommé sans nouveau message
        if (known.title !== s.title) {
          try {
            this.#transaction(db, [
            `UPDATE sessions SET title = ${lit(s.title)} WHERE id = ${lit(s.id)}`,
            `DELETE FROM texts WHERE session = ${lit(s.id)} AND role = 'title'`,
            `INSERT INTO texts (body, session, message, part, role, created) VALUES (${lit(s.title)}, ${lit(s.id)}, '', '', 'title', ${num(updated)})`,
            ]);
          } catch (e) {
            console.error(`index de recherche : ${s.id} : ${String(e)}`);
          }
        }
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
          // par pages de 100 messages : une session peut peser des centaines de Mo d'un coup
          // (sorties d'outils), au-delà de ce que libsoup accepte en une réponse
          // seuls les textes sont gardés, page par page (pas les sorties d'outils)
          const texts: IndexedText[] = [];
          let before: string | undefined;
          for (let n = 0; ; n += 1) {
            if (n === 1000) {
              console.warn(`index de recherche : ${session.id} : plus de 100 000 messages, les plus anciens ne sont pas indexés`);
              break;
            }
            // oxlint-disable-next-line no-await-in-loop -- pages successives
            const page = await this.#client.messagePage(session.id, 100, before);
            texts.unshift(...textsOf(page.messages));
            if (page.older === null) break;
            before = page.older;
          }
          const updated = session.time.updated ?? session.time.created;
          const id = lit(session.id);
          // une transaction par session : la base reste cohérente si l'application s'arrête
          this.#transaction(db, [
            `DELETE FROM texts WHERE session = ${id}`,
            `INSERT OR REPLACE INTO sessions (id, title, directory, project, updated) VALUES (${id}, ${lit(session.title)}, ${lit(session.directory)}, ${lit(session.projectID)}, ${num(updated)})`,
            `INSERT INTO texts (body, session, message, part, role, created) VALUES (${lit(session.title)}, ${id}, '', '', 'title', ${num(updated)})`,
            ...texts.map((t) => `INSERT INTO texts (body, session, message, part, role, created) VALUES (${lit(t.text)}, ${id}, ${lit(t.message)}, ${lit(t.part)}, ${lit(t.role)}, ${num(t.created)})`),
          ]);
        } catch (e) {
          // session supprimée entre-temps, serveur occupé… : relue à la prochaine mise à jour
          console.error(`index de recherche : ${session.id} : ${String(e)}`);
        }
        done += 1;
        progress?.(done, done + todo.length);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  /**
   * Requête préparée par le parseur de libgda en mode « délimitation » : le SQL est transmis tel
   * quel à SQLite (l'analyse complète de libgda ne connaît pas MATCH ni les grands entiers).
   */
  #statement(db: GdaNs.Connection, sql: string): GdaNs.Statement {
    if (Gda === null) throw new Error('libgda absent');
    if (this.#parser === null) {
      this.#parser = db.create_parser();
      this.#parser.mode = Gda.SqlParserMode.DELIMIT;
    }
    const [stmt] = this.#parser.parse_string(sql);
    if (stmt === null) throw new Error(`requête SQL invalide : ${sql.slice(0, 80)}`);
    return stmt;
  }

  #exec(db: GdaNs.Connection, sql: string): void {
    db.statement_execute_non_select(this.#statement(db, sql), null);
  }

  #transaction(db: GdaNs.Connection, statements: readonly string[]): void {
    this.#exec(db, 'BEGIN');
    try {
      for (const sql of statements) this.#exec(db, sql);
      this.#exec(db, 'COMMIT');
    } catch (e) {
      try {
        this.#exec(db, 'ROLLBACK');
      } catch {
        // transaction déjà close : l'erreur d'origine est remontée
      }
      throw e;
    }
  }

  /** Résultats, du plus récent au plus ancien (au plus `limit`). */
  search(query: string, filter: SearchFilter = {}, limit = 200): SearchHit[] {
    const q = terms(query);
    if (q.length === 0) return [];
    const db = this.#open();
    const long = q.filter((t) => t.length >= TRIGRAM);
    // termes courts comparés par LIKE au texte non replié : pris tels que saisis (accents
    // compris : « où » trouve « où »), en minuscules
    const raw = query.toLowerCase().split(/\s+/u).filter((t) => t !== '');
    const short = raw.filter((t) => fold(t).length < TRIGRAM);
    const where = [
      ...(long.length === 0 ? [] : [`texts MATCH ${lit(long.map((t) => phrase(t)).join(' AND '))}`]),
      // 1 ou 2 caractères : hors de portée du trigram, filtrés par LIKE (sans casse ASCII, sensible aux accents)
      ...short.map((t) => `texts.body LIKE ${lit(`%${t.replaceAll(/[%_!]/gu, (c) => `!${c}`)}%`)} ESCAPE '!'`),
      ...(filter.project === undefined ? [] : [`(sessions.project = ${lit(filter.project)} OR 'dir:' || sessions.directory = ${lit(filter.project)})`]),
      ...(filter.since === undefined ? [] : [`CAST(texts.created AS INTEGER) >= ${num(filter.since)}`]),
    ];
    const rows = this.#strings(
      db,
      `SELECT sessions.id, sessions.title, sessions.directory, sessions.project, CAST(sessions.updated AS TEXT), texts.message, texts.part, texts.role, CAST(texts.created AS TEXT), texts.body
       FROM texts JOIN sessions ON sessions.id = texts.session
       WHERE ${where.join(' AND ')}
       ORDER BY CAST(texts.created AS INTEGER) DESC LIMIT ${Math.trunc(limit)}`,
    );
    return rows.map(([id, title, directory, project, updated, message, part, role, created, body]) => {
      const session: IndexedSession = { id: id ?? '', title: title ?? '', directory: directory ?? '', projectID: project ?? '', updated: Number(updated ?? 0) };
      if (role === 'title') return { session, text: null, snippet: session.title };
      const text: IndexedText = { message: message ?? '', part: part ?? '', role: role === 'user' ? 'user' : 'assistant', created: Number(created ?? 0), text: body ?? '' };
      return { session, text, snippet: snippetOf(text.text, q) };
    });
  }
}
