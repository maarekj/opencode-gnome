// Bac à sable des captures et des tests (écran virtuel) : rien ne doit sortir vers la session de
// l'utilisateur (gestionnaire de fichiers, navigateur, terminal, services systemd). Les actions
// concernées sont journalisées au lieu d'être lancées.
import GLib from 'gi://GLib';

/** Posé par `scripts/screenshot.ts` et `scripts/test.ts` ; `OPENCODE_GNOME_TEST_LINKS` (historique) aussi. */
export const sandboxed = (): boolean => GLib.getenv('OPENCODE_GNOME_SANDBOX') !== null || GLib.getenv('OPENCODE_GNOME_TEST_LINKS') !== null;

/**
 * En bac à sable : journalise l'action (`ÉTIQUETTE détail`) et renvoie true ; l'appelant ne
 * lance alors rien.
 */
export function intercepted(label: string, detail: string): boolean {
  if (!sandboxed()) return false;
  console.log(`${label} ${detail}`);
  return true;
}
