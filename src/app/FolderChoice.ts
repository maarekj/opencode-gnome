// Champ « Dossier » des dialogues de terminal et de lien (#145).
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { folderOf, type FolderEntry } from '../shared/layout.ts';
import { layoutOf, type Settings } from '../shared/settings.ts';

/** Dossiers de la barre du projet. */
export const foldersOf = (settings: Settings, project: string): FolderEntry[] => layoutOf(settings.data.peek(), project).filter((e): e is FolderEntry => 'folder' in e);

/** Dossier actuel de l'élément `key` (null : premier niveau). */
export const currentFolder = (settings: Settings, project: string, key: string): string | null => folderOf(layoutOf(settings.data.peek(), project), key);

/**
 * Liste « Dossier » (aucun ou un dossier du projet), sélection initiale `initial` ; null sans
 * dossier. `value()` : dossier choisi (null : premier niveau).
 */
export function folderChooser(settings: Settings, project: string, initial: string | null): { row: Adw.ComboRow | null; value: () => string | null } {
  const folders = foldersOf(settings, project);
  if (folders.length === 0) return { row: null, value: () => null };
  const row = new Adw.ComboRow({ title: 'Dossier', model: Gtk.StringList.new(['Aucun (barre)', ...folders.map((f) => f.name)]) });
  row.selected = Math.max(0, folders.findIndex((f) => f.folder === initial) + 1);
  return { row, value: () => (row.selected === 0 ? null : (folders[row.selected - 1]?.folder ?? null)) };
}
