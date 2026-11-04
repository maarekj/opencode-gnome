// Classes CSS suivant un état, sans remplacer les autres (#164) : `cssClasses` lié remplace toute
// la liste et retire les classes ajoutées par GTK / libadwaita (`activatable` d'une ligne de
// liste, dont dépend le survol du thème).
import type Gtk from 'gi://Gtk?version=4.0';
import { onCleanup, type Accessor } from 'gnim';

/** Ajoute ou retire chaque classe de `classes` selon son booléen, à chaque changement de `state`. */
export function bindClasses<T>(widget: Gtk.Widget, state: Accessor<T>, classes: (value: T) => Readonly<Record<string, boolean>>): void {
  const apply = (): void => {
    for (const [name, on] of Object.entries(classes(state.peek()))) {
      if (on) widget.add_css_class(name);
      else widget.remove_css_class(name);
    }
  };
  apply();
  onCleanup(state.subscribe(apply));
}
