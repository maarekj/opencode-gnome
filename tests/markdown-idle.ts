// Non-régression #57 : une fois affichée, une conversation markdown (paragraphes, tableau) ne
// fait plus tourner l'horloge d'images (pas de tick callback permanent).
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { createRoot } from 'gnim';
import { MarkdownView } from '../src/app/Markdown.tsx';

Gtk.init();
const win = new Gtk.Window({ defaultWidth: 800, defaultHeight: 600 });
const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
win.set_child(new Gtk.ScrolledWindow({ child: box }));
createRoot(() => {
  for (let i = 0; i < 20; i += 1) box.append(MarkdownView({ text: `Paragraphe **${i}** avec du texte.\n\n| a | b |\n|---|---|\n| ${i} | x |` }));
});
win.present();
const loop = new GLib.MainLoop(null, false);
let before = 0;
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
  before = win.get_frame_clock()?.get_frame_counter() ?? 0;
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
    const frames = (win.get_frame_clock()?.get_frame_counter() ?? 0) - before;
    print(frames <= 5 ? 'TEST OK' : `horloge active au repos : ${frames} images en 1 s`);
    win.destroy();
    loop.quit();
    return GLib.SOURCE_REMOVE;
  });
  return GLib.SOURCE_REMOVE;
});
loop.run();
