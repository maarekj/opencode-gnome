// Libellés des listes déroulantes (Adw.ComboRow) affichés en entier : la fabrique par défaut tronque
// les longs libellés (modèles « anthropic/claude-… » tous identiques une fois coupés).
import type GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

/** Lignes de la liste déroulante : libellé complet (pas d'ellipse), la liste s'élargit. */
export function fullLabelFactory(inRow = false): Gtk.SignalListItemFactory {
  const factory = new Gtk.SignalListItemFactory();
  factory.connect('setup', (_f: Gtk.SignalListItemFactory, item: GObject.Object) => {
    if (!(item instanceof Gtk.ListItem)) return;
    // valeur affichée dans la ligne : une seule ligne, coupée seulement faute de place
    item.child = inRow
      ? new Gtk.Label({ xalign: 1, ellipsize: Pango.EllipsizeMode.END })
      : new Gtk.Label({ xalign: 0, maxWidthChars: 70, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR });
  });
  factory.connect('bind', (_f: Gtk.SignalListItemFactory, item: GObject.Object) => {
    if (!(item instanceof Gtk.ListItem)) return;
    const label = item.child;
    const str = item.item;
    if (label instanceof Gtk.Label && str instanceof Gtk.StringObject) label.label = str.string;
  });
  return factory;
}
