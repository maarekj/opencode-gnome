// Terminaux persistants par projet : une session zellij nommée par terminal. La commande tourne
// en arrière-plan ; fermer la fenêtre du terminal détache sans l'arrêter.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { createState, type Accessor } from 'gnim';
import type { ProjectTerminal } from './settings.ts';
import { openTerminalArgv, shq, type TerminalChoice } from './terminal.ts';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async', 'wait_finish');

/** Intervalle de relecture de l'état des sessions zellij (ms). */
const POLL_MS = 4000;

const slug = (s: string): string =>
  s
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036F]/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-|-$/gu, '')
    .slice(0, 16) || 'terminal';

/** Nom de session zellij stable et unique : `og-<projet>-<nom>`. */
export function terminalId(project: string, name: string, taken: readonly string[]): string {
  const base = `og-${slug(GLib.path_get_basename(project))}-${slug(name)}`;
  let id = base;
  for (let i = 2; taken.includes(id); i += 1) id = `${base}-${i}`;
  return id;
}

async function run(argv: readonly string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE });
  if (cwd !== undefined) launcher.set_cwd(cwd);
  // L'app n'a pas de terminal : le serveur zellij créé ici transmettrait un TERM vide à ses
  // panneaux, et les shells interactifs (zle, readline) ne savent plus redessiner la ligne.
  launcher.setenv('TERM', 'xterm-256color', true);
  launcher.setenv('COLORTERM', 'truecolor', true);
  const proc = launcher.spawnv([...argv]);
  const [out] = await proc.communicate_utf8_async(null, null);
  return { ok: proc.get_successful(), out: out ?? '' };
}

export const zellijInstalled = (): boolean => GLib.find_program_in_path('zellij') !== null;

/** Sessions zellij vivantes (les sessions « EXITED » ne comptent pas). */
async function liveSessions(): Promise<Set<string>> {
  const { out } = await run(['zellij', 'list-sessions', '--no-formatting']);
  const names = out
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.includes('EXITED'))
    .map((l) => l.split(' ')[0] ?? '');
  return new Set(names);
}

export class TerminalManager {
  /** identifiants des terminaux en cours */
  readonly running: Accessor<ReadonlySet<string>>;
  readonly #set: (v: ReadonlySet<string>) => void;
  readonly #choice: () => TerminalChoice;
  #timer = 0;

  constructor(choice: () => TerminalChoice) {
    this.#choice = choice;
    [this.running, this.#set] = createState<ReadonlySet<string>>(new Set(), { equals: (a, b) => a.size === b.size && [...a].every((x) => b.has(x)) });
  }

  /** Relit l'état maintenant puis périodiquement. */
  watch(): void {
    if (this.#timer !== 0) return;
    void this.refresh();
    this.#timer = GLib.timeout_add(GLib.PRIORITY_LOW, POLL_MS, () => {
      void this.refresh();
      return GLib.SOURCE_CONTINUE;
    });
  }

  async refresh(): Promise<void> {
    if (!zellijInstalled()) return;
    try {
      this.#set(await liveSessions());
    } catch (e) {
      console.error(`zellij : ${String(e)}`);
    }
  }

  isRunning(id: string): boolean {
    return this.running.peek().has(id);
  }

  /** Démarre la commande en arrière-plan (shell interactif qui reste ouvert si elle s'arrête). */
  async start(t: ProjectTerminal, project: string): Promise<void> {
    if (!zellijInstalled()) throw new Error('zellij introuvable');
    const cwd = cwdOf(t, project);
    // session morte (résurrection possible) : supprimée pour repartir de la commande configurée
    await run(['zellij', 'delete-session', t.id]);
    const shell = GLib.getenv('SHELL') ?? '/bin/sh';
    const res = await run(['zellij', 'attach', '--create-background', t.id, '--', ...shellArgv(t.command, shell)], cwd);
    if (!res.ok) throw new Error(`zellij : ${res.out.trim()}`);
    await this.refresh();
  }

  /** Ouvre le terminal sur la session (la démarre si elle est arrêtée). */
  async open(t: ProjectTerminal, project: string): Promise<void> {
    if (!this.isRunning(t.id)) await this.start(t, project);
    openTerminalArgv(['zellij', 'attach', t.id], cwdOf(t, project), this.#choice());
  }

  async stop(t: ProjectTerminal): Promise<void> {
    await run(['zellij', 'delete-session', '--force', t.id]);
    await this.refresh();
  }

  async restart(t: ProjectTerminal, project: string): Promise<void> {
    await this.stop(t);
    await this.start(t, project);
  }
}

/**
 * Programme lancé dans la session. Sans commande, ou si la commande est un shell, le shell
 * interactif est lancé directement : deux shells interactifs imbriqués se disputent le terminal
 * (frappe affichée en double, effacement cassé).
 */
export function shellArgv(command: string, shell: string): string[] {
  const c = command.trim();
  const shells = new Set([shell, GLib.path_get_basename(shell), 'sh', 'bash', 'zsh', 'fish']);
  if (c === '' || shells.has(c)) return [c === '' ? shell : (GLib.find_program_in_path(c) ?? shell), '-i'];
  return [shell, '-ic', `${c}; exec ${shq(shell)} -i`];
}

/** Répertoire de lancement : relatif à la racine du projet, `~/…` ou absolu. */
export function resolveCwd(cwd: string | undefined, project: string): string {
  const c = (cwd ?? '').trim();
  if (c === '' || c === '.') return project;
  if (c === '~' || c.startsWith('~/')) return GLib.build_filenamev([GLib.get_home_dir(), c.slice(1)]);
  if (GLib.path_is_absolute(c)) return c;
  return GLib.canonicalize_filename(c, project);
}

const cwdOf = (t: ProjectTerminal, project: string): string => {
  const dir = resolveCwd(t.cwd, project);
  return GLib.file_test(dir, GLib.FileTest.IS_DIR) ? dir : GLib.get_home_dir();
};
