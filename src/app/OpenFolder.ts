// Ouverture d'un dossier dans le gestionnaire de fichiers par défaut du système.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { errorMessage } from '../shared/errors.ts';

Gio._promisify(Gtk.FileLauncher.prototype, 'launch', 'launch_finish');

/** Ouvre un fichier dans l'application par défaut (OPENCODE_GNOME_TEST_LINKS : journalisé). */
export function openFile(from: Gtk.Widget, path: string): void {
  if (GLib.getenv('OPENCODE_GNOME_TEST_LINKS') !== null) {
    console.log(`FICHIER ${path}`);
    return;
  }
  const root = from.get_root();
  new Gtk.FileLauncher({ file: Gio.File.new_for_path(path) }).launch(root instanceof Gtk.Window ? root : null, null).catch((e: unknown) => {
    console.error(`Ouverture de ${path} impossible : ${errorMessage(e)}`);
  });
}

/** Ouvre un dossier dans le gestionnaire de fichiers par défaut (OPENCODE_GNOME_TEST_LINKS : journalisé). */
export function openFolder(from: Gtk.Widget, directory: string, toast: (m: string) => void): void {
  if (!GLib.file_test(directory, GLib.FileTest.IS_DIR)) {
    toast(`Dossier introuvable : ${directory}`);
    return;
  }
  if (GLib.getenv('OPENCODE_GNOME_TEST_LINKS') !== null) {
    console.log(`DOSSIER ${directory}`);
    return;
  }
  const root = from.get_root();
  new Gtk.FileLauncher({ file: Gio.File.new_for_path(directory) }).launch(root instanceof Gtk.Window ? root : null, null).catch((e: unknown) => {
    toast(`Ouverture du dossier impossible : ${errorMessage(e)}`);
  });
}

