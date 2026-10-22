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

/**
 * Ouvre `command` dans un terminal, dans `cwd`, via un shell interactif qui reste ouvert après.
 * Terminal : `wanted` (préférences), sinon $OPENCODE_GNOME_TERMINAL, sinon le premier installé.
 * Retourne le terminal utilisé.
 */
export function openTerminal(command: string, cwd: string, wanted?: string): string {
  const name = wanted ?? GLib.getenv('OPENCODE_GNOME_TERMINAL') ?? installedTerminals()[0];
  if (name === undefined) throw new Error('Aucun terminal trouvé (définis OPENCODE_GNOME_TERMINAL)');
  const [bin = name, ...prefix] = TERMINALS[name] ?? [name, '-e'];
  const shell = GLib.getenv('SHELL') ?? '/bin/sh';
  GLib.spawn_async(cwd, [bin, ...prefix, shell, '-ic', `${command}; exec ${shq(shell)} -i`], null, GLib.SpawnFlags.SEARCH_PATH, null);
  return name;
}
