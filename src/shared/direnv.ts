// Environnement direnv d'un dossier (`direnv export json`), pour résoudre les variables des
// liens épinglés : chaque worktree a son .envrc (ports différents…). Cache par .envrc, invalidé
// quand il change. Même principe que le plugin opencode (data/opencode-plugin/direnv.js).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as z from 'zod/mini';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

const Exported = z.record(z.string(), z.nullable(z.string()));

/** .envrc le plus proche (le dossier ou un parent), ou null. */
export function findEnvrc(dir: string): string | null {
  for (let d = dir; ; d = GLib.path_get_dirname(d)) {
    const f = GLib.build_filenamev([d, '.envrc']);
    if (GLib.file_test(f, GLib.FileTest.EXISTS)) return f;
    if (GLib.path_get_dirname(d) === d) return null;
  }
}

const mtime = (path: string): number => {
  // fichier absent : 0 (sa création invalide le cache)
  try {
    return Gio.File.new_for_path(path).query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null).get_modification_date_time()?.to_unix() ?? 0;
  } catch {
    return 0;
  }
};

/** Empreinte : dates du .envrc et des fichiers que direnv surveille (dotenv, source_env, devenv.lock…). */
const stampOf = (envrc: string, watched: readonly string[]): string => [envrc, ...watched].map((f) => `${f}:${mtime(f)}`).join('|');

/** Fichiers surveillés, décodés depuis DIRENV_WATCHES (base64url de JSON compressé zlib) ; [] si illisible. */
function watchesOf(value: string | null | undefined): string[] {
  if (value === null || value === undefined || value === '') return [];
  try {
    const raw = GLib.base64_decode(value.replaceAll('-', '+').replaceAll('_', '/'));
    const conv = new Gio.ZlibDecompressor({ format: Gio.ZlibCompressorFormat.ZLIB });
    const stream = new Gio.ConverterInputStream({ baseStream: Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(raw)), converter: conv });
    const out = Gio.MemoryOutputStream.new_resizable();
    out.splice(stream, Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET, null);
    const json: unknown = JSON.parse(new TextDecoder().decode(out.steal_as_bytes().toArray()));
    return Array.isArray(json) ? json.flatMap((w: unknown) => (typeof w === 'object' && w !== null && 'path' in w && typeof w.path === 'string' ? [w.path] : [])) : [];
  } catch {
    return [];
  }
}

const cache = new Map<string, { stamp: string; watched: string[]; env: Record<string, string> }>();

export class DirenvError extends Error {}

/** Variables apportées par direnv dans `dir` ({} sans .envrc). Lève une DirenvError si le .envrc est refusé. */
export async function direnvEnv(dir: string): Promise<Record<string, string>> {
  const envrc = findEnvrc(dir);
  if (envrc === null) return {};
  if (GLib.find_program_in_path('direnv') === null) throw new DirenvError(`direnv introuvable : ${envrc} non chargé`);
  const cached = cache.get(envrc);
  if (cached !== undefined && cached.stamp === stampOf(envrc, cached.watched)) return cached.env;
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE });
  launcher.set_cwd(GLib.path_get_dirname(envrc));
  // export complet : sans traces d'un direnv déjà chargé dans l'environnement de l'app
  for (const k of GLib.listenv()) if (k.startsWith('DIRENV_')) launcher.unsetenv(k);
  const proc = launcher.spawnv(['direnv', 'export', 'json']);
  const [out, err] = await proc.communicate_utf8_async(null, null);
  if (!proc.get_successful()) {
    const last = (err ?? '').trim().split('\n').at(-1) ?? '';
    throw new DirenvError(/is blocked|not allowed/iu.test(last) ? `.envrc non autorisé (direnv allow dans ${GLib.path_get_dirname(envrc)})` : `direnv : ${last}`);
  }
  const parsed = Exported.safeParse((out ?? '').trim() === '' ? {} : JSON.parse(out ?? '{}'));
  const env: Record<string, string> = {};
  if (parsed.success) for (const [k, v] of Object.entries(parsed.data)) if (v !== null && !k.startsWith('DIRENV_')) env[k] = v;
  const watched = watchesOf(parsed.success ? parsed.data['DIRENV_WATCHES'] : null);
  cache.set(envrc, { stamp: stampOf(envrc, watched), watched, env });
  return env;
}

const VAR = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/gu;

/** Noms des variables utilisées dans un texte (`$VAR`, `${VAR}`). */
export const variablesOf = (text: string): string[] => [...text.matchAll(VAR)].map((m) => m[1] ?? m[2] ?? '');

/**
 * Remplace `$VAR` / `${VAR}` par leur valeur : direnv du dossier, puis environnement de l'app.
 * Lève une erreur si une variable est inconnue.
 */
export async function expandVariables(text: string, dir: string): Promise<string> {
  if (variablesOf(text).length === 0) return text;
  return substitute(text, await direnvEnv(dir), dir);
}

/** Substitution pure : `env`, puis environnement de l'app ; erreur si une variable est inconnue. */
export function substitute(text: string, env: Readonly<Record<string, string>>, dir: string): string {
  const missing: string[] = [];
  const result = text.replaceAll(VAR, (_m, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? '';
    const value = env[name] ?? GLib.getenv(name);
    if (value === null) missing.push(name);
    return value ?? '';
  });
  if (missing.length > 0) throw new Error(`variable${missing.length > 1 ? 's' : ''} inconnue${missing.length > 1 ? 's' : ''} dans ${dir} : ${missing.join(', ')}`);
  return result;
}

/**
 * Adresse complétée d'un schéma si besoin : `localhost:3000`, `monhote:8080/x`, `api.local` →
 * `http://…`. Un schéma n'est reconnu que suivi de `//`, ou parmi ceux qui n'en ont pas.
 */
export function withScheme(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(url) || /^(?:mailto|file|about|data|javascript):/iu.test(url)) return url;
  return `http://${url}`;
}
