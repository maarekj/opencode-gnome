// Méthode de saisie : appliquée par main.tsx avant la création de tout widget (#138).
//
// Avec GTK_IM_MODULE=ibus (défini par NixOS pour toute la session), GTK crée un contexte IBus
// (CreateInputContext, par D-Bus vers ibus-daemon) pour chaque Gtk.TextView, même non éditable,
// et ne le détruit pas tant que l'application tourne. Le rendu markdown utilise des TextView par
// message, reconstruits pendant le streaming : des milliers de contextes saturent ibus-daemon, par
// lequel passe tout le clavier de GNOME → plus aucune saisie possible, dans toutes les applications,
// pendant plusieurs minutes.
//
// Sous Wayland, le module « wayland » (text-input, défaut de GTK) suffit : GNOME Shell pilote IBus
// lui-même avec un seul contexte, seul le widget qui a le focus communique avec le compositeur.
// Les méthodes de saisie (IBus, dispositions) restent disponibles.
import GLib from 'gi://GLib';

/** Module de saisie à imposer, ou null pour garder celui de l'environnement. */
export function inputModuleOverride(env: { wayland: string | null; module: string | null }): string | null {
  if (env.wayland === null || env.wayland === '') return null;
  return env.module === 'ibus' ? 'wayland' : null;
}

/** Impose le module de saisie si besoin (GTK lit GTK_IM_MODULE à la création de chaque contexte). */
export function applyInputMethod(): void {
  const override = inputModuleOverride({ wayland: GLib.getenv('WAYLAND_DISPLAY'), module: GLib.getenv('GTK_IM_MODULE') });
  if (override !== null) GLib.setenv('GTK_IM_MODULE', override, true);
}
