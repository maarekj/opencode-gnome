// Non-régression #96 : un lien d'une cellule de tableau passe par le même chemin que les autres
// (journalisé avec OPENCODE_GNOME_TEST_LINKS, pas d'ouverture du navigateur).
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { createRoot } from 'gnim';
import { MarkdownView, testLinks } from '../src/app/Markdown.tsx';

Gtk.init();
GLib.setenv('OPENCODE_GNOME_TEST_LINKS', '1', true);
let view: Gtk.Widget | null = null;
createRoot(() => {
  view = MarkdownView({ text: '| a |\n|---|\n| [doc](https://exemple.org/doc) |' });
});
const labels: Gtk.Label[] = [];
const walk = (w: Gtk.Widget | null): void => {
  for (let c = w; c !== null; c = c.get_next_sibling()) {
    if (c instanceof Gtk.Label && c.get_text().includes('doc')) labels.push(c);
    walk(c.get_first_child());
  }
};
walk(view);
labels[0]?.emit('activate-link', 'https://exemple.org/doc');
print(testLinks.includes('https://exemple.org/doc') ? 'TEST OK' : `lien non intercepté : ${JSON.stringify(testLinks)}`);
