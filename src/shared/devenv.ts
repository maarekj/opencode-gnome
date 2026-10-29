// Process manager de devenv (2.x) d'un dossier (#147) : services lancés par `devenv up`, lus et
// pilotés par `devenv processes …` (rapide : pas d'évaluation Nix, sauf `devenv up -d`).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type { ProjectDevenv } from './settings.ts';
import { resolveCwd } from './paths.ts';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async', 'wait_finish');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish');

export interface DevenvProcess {
  readonly name: string;
  /** phase brute de devenv : ready, running, starting, stopped, gave_up, failed, completed… */
  readonly phase: string;
  readonly restarts: number;
}

/** État du process manager : arrêté, en marche avec ses services, ou erreur (devenv absent…). */
export type DevenvState = { readonly kind: 'stopped' } | { readonly kind: 'running'; readonly processes: readonly DevenvProcess[] } | { readonly kind: 'error'; readonly message: string };

/** Catégorie d'une phase, pour l'affichage (couleur, actions). */
export type PhaseKind = 'ok' | 'busy' | 'stopped' | 'failed';

export function phaseKind(phase: string): PhaseKind {
  if (phase === 'ready' || phase === 'running' || phase === 'completed') return 'ok';
  if (phase === 'gave_up' || phase === 'failed' || phase === 'error' || phase === 'crashed') return 'failed';
  if (phase === 'stopped' || phase === 'disabled' || phase === 'not_started' || phase === 'exited') return 'stopped';
  return 'busy';
}

const PHASE_LABEL: Readonly<Record<string, string>> = {
  ready: 'prêt',
  running: 'en cours',
  completed: 'terminé',
  starting: 'démarrage…',
  pending: 'en attente',
  restarting: 'redémarrage…',
  stopping: 'arrêt…',
  stopped: 'arrêté',
  not_started: 'pas démarré',
  disabled: 'désactivé',
  exited: 'terminé',
  gave_up: 'en échec',
  failed: 'en échec',
  crashed: 'en échec',
};

export const phaseLabel = (phase: string): string => PHASE_LABEL[phase] ?? phase.replaceAll('_', ' ');

/** Lit `devenv processes list` : une ligne « nom  phase restarts: N » par service. */
export function parseProcessList(out: string): DevenvProcess[] {
  const list: DevenvProcess[] = [];
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)(?:\s+restarts:\s*(\d+))?\s*$/u.exec(line.trim());
    if (m === null) continue;
    list.push({ name: m[1] ?? '', phase: m[2] ?? '', restarts: Number(m[3] ?? 0) });
  }
  return list;
}

/** séquences d'échappement ANSI (couleurs, curseur) */
// oxlint-disable-next-line no-control-regex -- l'échappement ANSI commence par ESC
const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/gu;

/** Message d'erreur de devenv sans couleurs ni puces (« × … »). */
export const cleanMessage = (out: string): string =>
  out
    .replaceAll(ANSI, '')
    .split('\n')
    .map((l) => l.replace(/^\s*[×✗•]\s*/u, '').trimEnd())
    .filter((l) => l.trim() !== '')
    .join('\n');

const NOT_RUNNING = /No process manager is running/u;

/** Dossier du devenv (contenant devenv.nix). */
export const devenvDir = (d: ProjectDevenv, project: string): string => resolveCwd(d.cwd, project);

export const devenvInstalled = (): boolean => GLib.find_program_in_path('devenv') !== null;

interface Result {
  readonly ok: boolean;
  readonly out: string;
  readonly err: string;
}

/** `devenv …` dans `dir` (sans TUI ni couleurs). */
export async function devenv(dir: string, args: readonly string[]): Promise<Result> {
  const bin = GLib.find_program_in_path('devenv');
  if (bin === null) return { ok: false, out: '', err: 'devenv introuvable (PATH)' };
  if (!GLib.file_test(dir, GLib.FileTest.IS_DIR)) return { ok: false, out: '', err: `dossier introuvable : ${dir}` };
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE });
  launcher.set_cwd(dir);
  launcher.setenv('NO_COLOR', '1', true);
  launcher.setenv('DEVENV_TUI', 'false', true);
  const proc = launcher.spawnv([bin, ...args]);
  const [out, err] = await proc.communicate_utf8_async(null, null);
  return { ok: proc.get_successful(), out: out ?? '', err: err ?? '' };
}

/** Services du process manager du dossier. */
export async function devenvStatus(dir: string): Promise<DevenvState> {
  const r = await devenv(dir, ['processes', 'list']);
  if (r.ok) return { kind: 'running', processes: parseProcessList(r.out) };
  const message = cleanMessage(`${r.err}\n${r.out}`);
  return NOT_RUNNING.test(message) ? { kind: 'stopped' } : { kind: 'error', message: message || 'devenv processes list a échoué' };
}

/** Action sur le process manager ; exception avec le message de devenv si elle échoue. */
export async function devenvAction(dir: string, action: 'up' | 'down' | 'start' | 'stop' | 'restart', name?: string): Promise<void> {
  const args = action === 'up' ? ['up', '--detach', '--no-tui'] : ['processes', action, ...(name === undefined ? [] : [name])];
  const r = await devenv(dir, args);
  if (!r.ok) throw new Error(cleanMessage(`${r.err}\n${r.out}`) || `devenv ${args.join(' ')} a échoué`);
}

/**
 * Action longue (démarrage : évaluation Nix, construction) dont la sortie est suivie ligne à ligne
 * (`onLine`) : `up` = tout démarrer, `start` + nom = un service (démarre le process manager au besoin).
 */
export async function devenvStream(dir: string, action: 'up' | 'start', name: string | undefined, onLine: (line: string) => void): Promise<void> {
  const bin = GLib.find_program_in_path('devenv');
  if (bin === null) throw new Error('devenv introuvable (PATH)');
  if (!GLib.file_test(dir, GLib.FileTest.IS_DIR)) throw new Error(`dossier introuvable : ${dir}`);
  const args = action === 'up' ? ['up', '--detach', '--no-tui'] : ['processes', 'start', ...(name === undefined ? [] : [name])];
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE });
  launcher.set_cwd(dir);
  launcher.setenv('NO_COLOR', '1', true);
  launcher.setenv('DEVENV_TUI', 'false', true);
  const proc = launcher.spawnv([bin, ...args]);
  const out = proc.get_stdout_pipe();
  const tail: string[] = [];
  if (out !== null) {
    const lines = new Gio.DataInputStream({ baseStream: out, closeBaseStream: true });
    const decoder = new TextDecoder();
    try {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- lecture séquentielle de la sortie
        const [bytes] = await lines.read_line_async(GLib.PRIORITY_DEFAULT, null);
        if (bytes === null) break;
        const line = decoder.decode(bytes).replaceAll(ANSI, '').replace(/\r$/u, '');
        tail.push(line);
        if (tail.length > 20) tail.shift();
        onLine(line);
      }
    } finally {
      lines.close(null);
    }
  }
  await proc.wait_async(null);
  if (!proc.get_successful()) throw new Error(cleanMessage(tail.join('\n')) || `devenv ${args.join(' ')} a échoué`);
}

/** Services connus en cache, mis à jour d'après la liste réelle : null si inchangé. */
export function refreshedServices(cached: readonly string[] | undefined, state: DevenvState | null): string[] | null {
  if (state?.kind !== 'running' || state.processes.length === 0) return null;
  const names = state.processes.map((p) => p.name);
  return cached !== undefined && cached.length === names.length && cached.every((n, i) => n === names[i]) ? null : names;
}

/** Dernières lignes de logs d'un service (stdout et stderr). */
export async function devenvLogs(dir: string, name: string, lines = 500): Promise<string> {
  const r = await devenv(dir, ['processes', 'logs', name, '--lines', String(lines)]);
  if (!r.ok) throw new Error(cleanMessage(`${r.err}\n${r.out}`) || 'logs indisponibles');
  return r.out.replaceAll(ANSI, '');
}

/** Résumé d'un état : « 3/3 prêts », « 1 en échec », « arrêté ». */
export function summary(state: DevenvState | null): { text: string; kind: PhaseKind } {
  if (state === null) return { text: '…', kind: 'busy' };
  if (state.kind === 'stopped') return { text: 'arrêté', kind: 'stopped' };
  if (state.kind === 'error') return { text: 'erreur', kind: 'failed' };
  const failed = state.processes.filter((p) => phaseKind(p.phase) === 'failed').length;
  const ok = state.processes.filter((p) => phaseKind(p.phase) === 'ok').length;
  if (failed > 0) return { text: `${failed} en échec`, kind: 'failed' };
  const busy = state.processes.some((p) => phaseKind(p.phase) === 'busy');
  // services arrêtés à dessein (les autres tournent) : pas d'alerte
  return { text: `${ok}/${state.processes.length}`, kind: busy || ok === 0 ? (busy ? 'busy' : 'stopped') : 'ok' };
}
