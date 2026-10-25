// Analyse des arguments et utilitaires communs aux commandes de la CLI `ocg`.
import GLib from 'gi://GLib';

export interface Args {
  readonly positional: string[];
  readonly options: Map<string, string>;
  readonly flags: Set<string>;
}

/** `--clé valeur`, `--clé=valeur` ; les clés de `flags` n'ont pas de valeur. `-h` = `--help`. */
export function parseArgs(argv: readonly string[], flags: ReadonlySet<string>): Args {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const found = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (a === '-h') found.add('help');
    else if (a.startsWith('--')) {
      const [key = '', inline] = a.slice(2).split(/=(.*)/su);
      if (flags.has(key) || key === 'help' || key === 'json') found.add(key);
      else {
        const value = inline ?? argv[(i += 1)];
        if (value === undefined) throw new Error(`--${key} : valeur manquante`);
        options.set(key, value);
      }
    } else positional.push(a);
  }
  return { positional, options, flags: found };
}

/** Chemin absolu (`~` développé, relatif au dossier courant). */
export const expand = (p: string): string => {
  const path = p.startsWith('~/') || p === '~' ? GLib.build_filenamev([GLib.get_home_dir(), p.slice(1)]) : p;
  return GLib.canonicalize_filename(path, GLib.get_current_dir());
};

/** Commande rejetée par l'utilisateur : message d'usage, code 2. */
export class UsageError extends Error {}
