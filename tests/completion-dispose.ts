// Non-régression #54 : libérer le compositeur pendant que la liste de complétion est ouverte ne
// doit produire aucun avertissement GTK (boucle infinie « GtkPopover is not a child of GtkTextView »).
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { CompletionPopover } from '../src/app/Completion.ts';

Gtk.init();
const win = new Gtk.Window({ defaultWidth: 600, defaultHeight: 400 });
const outer = new Gtk.Box();
const view = new Gtk.TextView();
const scrolled = new Gtk.ScrolledWindow({ child: view });
outer.append(scrolled);
win.set_child(outer);
const completion = new CompletionPopover(view);
win.present();
const loop = new GLib.MainLoop(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
  completion.show([{ title: '/test', accept: () => {} }], view.buffer.get_start_iter());
  return GLib.SOURCE_REMOVE;
});
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
  // libération explicite, comme le ramasse-miettes à la fermeture d'une session
  win.set_child(null);
  outer.run_dispose();
  scrolled.run_dispose();
  view.run_dispose();
  win.destroy();
  print('TEST OK');
  loop.quit();
  return GLib.SOURCE_REMOVE;
});
loop.run();
