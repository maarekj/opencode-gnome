// Ouverture d'un terminal sur une session opencode (`opencode attach`).
import GLib from 'gi://GLib';

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

export const installedTerminals = (): string[] => KNOWN_TERMINALS.filter((t) => GLib.find_program_in_path(t) !== null);

/** Échappe une chaîne pour le shell. */
export const shq = (s: string): string => (/^[\w@%+=:,./-]+$/u.test(s) ? s : `'${s.replaceAll("'", String.raw`'\''`)}'`);

/** Commande console qui reprend une session sur le serveur partagé. */
export const attachCommand = (url: string, directory: string, sessionID?: string): string =>
  ['opencode', 'attach', url, '--dir', directory, ...(sessionID === undefined ? [] : ['--session', sessionID])].map((a) => shq(a)).join(' ');

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

/**
 * Ouvre `command` dans un terminal, dans `cwd`, via un shell interactif qui reste ouvert après.
 * Priorité : préférence de l'utilisateur > $OPENCODE_GNOME_TERMINAL > premier terminal installé.
 * Lève une erreur si le terminal ne peut pas être lancé.
 */
export function openTerminal(command: string, cwd: string, choice: TerminalChoice = {}): void {
  const argv = terminalArgv(choice);
  const bin = argv[0] ?? '';
  if (GLib.find_program_in_path(bin) === null) throw new Error(`Terminal introuvable : ${bin} (Préférences)`);
  const shell = GLib.getenv('SHELL') ?? '/bin/sh';
  GLib.spawn_async(cwd, [...argv, shell, '-ic', `${command}; exec ${shq(shell)} -i`], null, GLib.SpawnFlags.SEARCH_PATH, null);
}
