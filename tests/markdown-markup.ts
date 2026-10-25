// Non-régression #56 : markdown à markup délicat (liens dans du gras, balises croisées, URL
// avec _ ou __) rendu sans avertissement GTK ni texte perdu.
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { MarkdownView } from '../src/app/Markdown.tsx';
import { createRoot } from 'gnim';

Gtk.init();
const SOURCES = [
  '**voir [la doc](https://example.com/a_b_c) ici**',
  '**gras *ital** suite*',
  'https://x.com/__tests__/_a_ et _fin_',
  '[voir https://a.b](https://c.d) & <balise>',
  '| a | **b [l](https://e.f)** |\n|---|---|\n| *x** | `c<d>` |',
];
const win = new Gtk.Window({ defaultWidth: 800, defaultHeight: 600 });
const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
win.set_child(box);
createRoot(() => {
  for (const text of SOURCES) box.append(MarkdownView({ text }));
});
win.present();
// le texte visible de chaque bloc doit contenir les mots clés
const texts: string[] = [];
const collect = (w: Gtk.Widget | null): void => {
  for (let c = w; c !== null; c = c.get_next_sibling()) {
    if (c instanceof Gtk.TextView) texts.push(c.buffer.text);
    if (c instanceof Gtk.Label) texts.push(c.get_text());
    collect(c.get_first_child());
  }
};
const loop = new GLib.MainLoop(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
  collect(box.get_first_child());
  const all = texts.join('\n');
  const missing = ['voir', 'la doc', 'ital', 'suite', '__tests__', '<balise>', 'c<d>'].filter((w) => !all.includes(w));
  if (missing.length > 0) print(`manquant : ${missing.join(', ')}\n${all}`);
  else print('TEST OK');
  win.destroy();
  loop.quit();
  return GLib.SOURCE_REMOVE;
});
loop.run();
