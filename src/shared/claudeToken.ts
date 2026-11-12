// Renouvellement du jeton du compte Claude (#167). Le plugin opencode-claude-auth (2.2.1) recopie
// `~/.claude/.credentials.json` dans opencode, mais n'appelle pas `claude` quand son propre
// renouvellement OAuth échoue « passagèrement » (429, réseau) : le jeton expire et les agents
// échouent. `claude -p` renouvelle le jeton (seulement près de l'expiration) ; le plugin adopte
// alors le nouveau. Seule l'heure d'expiration est lue : le jeton n'est jamais touché.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as z from 'zod/mini';
import { errorMessage } from './errors.ts';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

/** Renouvellement lancé à moins de 2 min de l'expiration (`claude` ne renouvelle pas avant). */
export const REFRESH_BEFORE_MS = 2 * 60_000;
/** Pause après un échec, avant un nouvel essai automatique. */
export const FAILURE_PAUSE_MS = 5 * 60_000;
/** Durée maximale d'un `claude -p`. */
const CLAUDE_TIMEOUT_S = 120;

const Credentials = z.object({ claudeAiOauth: z.object({ expiresAt: z.number() }) });
const State = z.object({
  lastAttempt: z.optional(z.number()),
  lastSuccess: z.optional(z.number()),
  lastError: z.optional(z.string()),
  /** échecs consécutifs */
  failures: z.optional(z.number()),
});
export type RefreshState = z.infer<typeof State>;

export function credentialsPath(): string {
  const dir = GLib.getenv('CLAUDE_CONFIG_DIR') ?? GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
  return GLib.build_filenamev([dir, '.credentials.json']);
}

const stateDir = (): string => GLib.build_filenamev([GLib.get_user_state_dir(), 'opencode-gnome']);
const statePath = (): string => GLib.build_filenamev([stateDir(), 'claude-refresh.json']);

function readJson(path: string): unknown {
  try {
    const [, bytes] = GLib.file_get_contents(path);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** Expiration du jeton (ms depuis l'époque) ; null : pas de compte Claude sur la machine. */
export function readExpiry(path = credentialsPath()): number | null {
  const r = Credentials.safeParse(readJson(path));
  return r.success ? r.data.claudeAiOauth.expiresAt : null;
}

export function readState(): RefreshState {
  const r = State.safeParse(readJson(statePath()));
  return r.success ? r.data : {};
}

function writeState(s: RefreshState): void {
  GLib.mkdir_with_parents(stateDir(), 0o700);
  GLib.file_set_contents(statePath(), JSON.stringify(s));
}

export type Decision = 'none' | 'valid' | 'refresh' | 'paused';

/** Faut-il lancer `claude` ? (`none` : pas de compte ; `paused` : échec récent). */
export function decide(expiresAt: number | null, state: RefreshState, now: number): Decision {
  if (expiresAt === null) return 'none';
  if (expiresAt - now > REFRESH_BEFORE_MS) return 'valid';
  const failedRecently = (state.failures ?? 0) > 0 && state.lastAttempt !== undefined && now - state.lastAttempt < FAILURE_PAUSE_MS;
  return failedRecently ? 'paused' : 'refresh';
}

/** État affiché par l'application et `ocg claude status`. */
export interface TokenStatus {
  readonly expiresAt: number;
  readonly expired: boolean;
  /** dernier essai en échec (pas de succès depuis) */
  readonly error: string | null;
  readonly lastSuccess: number | null;
}

export function tokenStatus(now = Date.now()): TokenStatus | null {
  const expiresAt = readExpiry();
  if (expiresAt === null) return null;
  const s = readState();
  return { expiresAt, expired: expiresAt <= now, error: (s.failures ?? 0) > 0 ? (s.lastError ?? 'échec') : null, lastSuccess: s.lastSuccess ?? null };
}

/** Verrou (un seul `claude` à la fois : timer, application, ligne de commande). */
function lock(): (() => void) | null {
  const path = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'opencode-gnome-claude-refresh.lock']);
  const file = Gio.File.new_for_path(path);
  try {
    file.create(Gio.FileCreateFlags.PRIVATE, null).close(null);
  } catch {
    // verrou laissé par un processus tué : ignoré au-delà de la durée maximale d'un essai
    const info = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
    const age = Date.now() / 1000 - info.get_attribute_uint64('time::modified');
    if (age < CLAUDE_TIMEOUT_S + 30) return null;
    file.replace_contents(new Uint8Array(), null, false, Gio.FileCreateFlags.PRIVATE, null);
  }
  return () => {
    try {
      file.delete(null);
    } catch {
      // déjà retiré
    }
  };
}

export interface RefreshResult {
  readonly decision: Decision | 'forced' | 'busy';
  readonly ok: boolean;
  readonly expiresAt: number | null;
  readonly error?: string;
}

/** Lance `claude -p . --model haiku` (même commande que le plugin), délai maximal compris. */
async function runClaude(): Promise<void> {
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE });
  launcher.setenv('TERM', 'dumb', true);
  launcher.set_cwd(GLib.get_tmp_dir());
  const proc = launcher.spawnv(['claude', '-p', '.', '--model', 'haiku']);
  const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CLAUDE_TIMEOUT_S, () => {
    proc.force_exit();
    return GLib.SOURCE_REMOVE;
  });
  try {
    const [, stderr] = await proc.communicate_utf8_async(null, null);
    if (!proc.get_successful()) {
      const lastLine = (stderr ?? '').trim().split('\n').at(-1) ?? '';
      const why = proc.get_if_signaled() ? `délai de ${CLAUDE_TIMEOUT_S} s dépassé` : lastLine === '' ? `code ${proc.get_exit_status()}` : lastLine;
      throw new Error(`claude : ${why}`);
    }
  } finally {
    GLib.source_remove(timer);
  }
}

/**
 * Renouvelle le jeton s'il expire bientôt (`force` : même s'il est encore valable ou en pause).
 * Succès : nouvelle expiration à plus d'une minute.
 */
export async function refreshToken(force = false): Promise<RefreshResult> {
  const now = Date.now();
  const before = readExpiry();
  const state = readState();
  const decision = decide(before, state, now);
  if (before === null) return { decision: 'none', ok: false, expiresAt: null, error: `pas de compte Claude (${credentialsPath()})` };
  if (!force && decision !== 'refresh') return { decision, ok: decision === 'valid', expiresAt: before };
  const unlock = lock();
  if (unlock === null) return { decision: 'busy', ok: false, expiresAt: before, error: 'renouvellement déjà en cours' };
  try {
    let error: string | undefined;
    try {
      await runClaude();
    } catch (e) {
      error = errorMessage(e);
    }
    const after = readExpiry();
    const ok = after !== null && after > Date.now() + 60_000;
    if (ok) writeState({ lastAttempt: now, lastSuccess: Date.now() });
    else {
      error ??= 'jeton toujours expiré après claude (reconnexion nécessaire : lancer claude)';
      writeState({ ...state, lastAttempt: now, lastError: error, failures: (state.failures ?? 0) + 1 });
    }
    return { decision: force ? 'forced' : decision, ok, expiresAt: after, ...(error === undefined || ok ? {} : { error }) };
  } finally {
    unlock();
  }
}
