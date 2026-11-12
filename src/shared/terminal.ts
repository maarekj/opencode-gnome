// Ouverture d'un terminal sur une session opencode (`opencode --server`, OpenCode 2).
import GLib from 'gi://GLib';
import { intercepted } from './sandbox.ts';
import { serverEnvPath } from './server.ts';

/** terminal -> préfixe argv qui exécute le programme + arguments suivants */
const TERMINALS: Readonly<Record<string, readonly string[]>> = {
  ptyxis: ['ptyxis', '--new-window', '--'],
  kgx: ['kgx', '-e'],
  'gnome-terminal': ['gnome-terminal', '--'],
  ghostty: ['ghostty', '-e'],
  kitty: ['kitty'],
  alacritty: ['alacritty', '-e'],
  wezterm: ['wezterm', 'start', '--'],
  foot: ['foot'],
  konsole: ['konsole', '-e'],
  'xdg-terminal-exec': ['xdg-terminal-exec'],
};

export const KNOWN_TERMINALS: readonly string[] = Object.keys(TERMINALS);

/** terminaux installés : recherchés une fois par processus (PATH long sous nix, #160) */
let installed: string[] | null = null;
export const installedTerminals = (): string[] => [...(installed ??= KNOWN_TERMINALS.filter((t) => GLib.find_program_in_path(t) !== null))];

/** Échappe une chaîne pour le shell. */
export const shq = (s: string): string => (/^[\w@%+=:,./-]+$/u.test(s) ? s : `'${s.replaceAll("'", String.raw`'\''`)}'`);

/**
 * Console OpenCode 2 attachée au serveur partagé, dans `directory` (reprend `sessionID`). Le mot
 * de passe du serveur est lu dans server.env au lancement (`OPENCODE_PASSWORD`), pas passé en
 * argument (visible dans la liste des processus).
 */
export function attachArgv(url: string, directory: string, sessionID?: string): string[] {
  const script = `pw=$(sed -n 's/^OPENCODE_SERVER_PASSWORD="\\(.*\\)"$/\\1/p' "$1" 2>/dev/null); export OPENCODE_PASSWORD="\${OPENCODE_SERVER_PASSWORD:-$pw}"; shift; exec opencode "$@"`;
  return ['sh', '-c', script, 'oc', serverEnvPath(), '--server', url, ...(sessionID === undefined ? [] : ['--session', sessionID]), directory];
}

/** Même commande, en une ligne de shell (terminal externe). */
export const attachCommand = (url: string, directory: string, sessionID?: string): string => attachArgv(url, directory, sessionID).map((a) => shq(a)).join(' ');

/** Choix du terminal (préférences). */
export interface TerminalChoice {
  /** nom d'un terminal connu, `custom`, ou absent (automatique) */
  readonly terminal?: string | undefined;
  /** commande libre si `terminal === 'custom'` (préfixe argv, ex. `foot -e`) */
  readonly command?: string | undefined;
}

/** Terminal retenu en mode automatique : $OPENCODE_GNOME_TERMINAL, sinon le premier installé. */
export const automaticTerminal = (): string | undefined => GLib.getenv('OPENCODE_GNOME_TERMINAL') ?? installedTerminals()[0];

/** Préfixe argv qui exécute le programme et les arguments qui suivent. */
function terminalArgv(choice: TerminalChoice): string[] {
  if (choice.terminal === 'custom') {
    let argv: string[] | null = null;
    try {
      [, argv] = GLib.shell_parse_argv(choice.command ?? '');
    } catch {
      argv = null; // guillemets non fermés…
    }
    if (argv === null || argv.length === 0) throw new Error('Commande de terminal personnalisée vide ou invalide (Préférences)');
    return argv;
  }
  const name = choice.terminal ?? automaticTerminal();
  if (name === undefined) throw new Error('Aucun terminal trouvé : choisis-en un dans les Préférences');
  return [...(TERMINALS[name] ?? [name, '-e'])];
}

/** Lance directement `program` dans un terminal (la fenêtre se ferme quand il se termine). */
export function openTerminalArgv(program: readonly string[], cwd: string, choice: TerminalChoice = {}): void {
  const argv = terminalArgv(choice);
  const bin = argv[0] ?? '';
  if (intercepted('TERMINAL', `${cwd} : ${program.join(' ')}`)) return;
  if (GLib.find_program_in_path(bin) === null) throw new Error(`Terminal introuvable : ${bin} (Préférences)`);
  GLib.spawn_async(cwd, [...argv, ...program], null, GLib.SpawnFlags.SEARCH_PATH, null);
}

/**
 * Ouvre `command` dans un terminal, dans `cwd`, via un shell interactif qui reste ouvert après.
 * Priorité : préférence de l'utilisateur > $OPENCODE_GNOME_TERMINAL > premier terminal installé.
 * Lève une erreur si le terminal ne peut pas être lancé.
 */
export function openTerminal(command: string, cwd: string, choice: TerminalChoice = {}): void {
  const argv = terminalArgv(choice);
  const bin = argv[0] ?? '';
  if (GLib.find_program_in_path(bin) === null) throw new Error(`Terminal introuvable : ${bin} (Préférences)`);
  if (intercepted('TERMINAL', `${cwd} : ${command}`)) return;
  const shell = GLib.getenv('SHELL') ?? '/bin/sh';
  GLib.spawn_async(cwd, [...argv, shell, '-ic', `${command}; exec ${shq(shell)} -i`], null, GLib.SpawnFlags.SEARCH_PATH, null);
}
