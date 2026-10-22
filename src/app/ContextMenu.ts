// Menu contextuel générique : clic droit et appui long (écran tactile).
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

export interface MenuItem {
  readonly label: string;
  readonly activate: () => void;
}

/**
 * Ajoute un menu contextuel à `widget`. `sections()` est appelée à chaque ouverture
 * (libellés à jour, ex. « Ajouter / Retirer des favoris ») ; chaque section est séparée par un trait.
 */
export function attachContextMenu(widget: Gtk.Widget, sections: () => readonly (readonly MenuItem[])[]): void {
  const group = new Gio.SimpleActionGroup();
  widget.insert_action_group('ctx', group);

  const popup = (x: number, y: number): void => {
    // actions recréées à chaque ouverture
    for (const name of group.list_actions()) group.remove_action(name);
    const model = new Gio.Menu();
    let n = 0;
    for (const items of sections()) {
      const section = new Gio.Menu();
      for (const item of items) {
        const name = `a${n}`;
        n += 1;
        const action = new Gio.SimpleAction({ name });
        action.connect('activate', item.activate);
        group.add_action(action);
        section.append(item.label, `ctx.${name}`);
      }
      model.append_section(null, section);
    }
    const popover = Gtk.PopoverMenu.new_from_model(model);
    popover.set_parent(widget);
    popover.hasArrow = false;
    popover.halign = Gtk.Align.START;
    popover.set_pointing_to(new Gdk.Rectangle({ x: Math.round(x), y: Math.round(y), width: 1, height: 1 }));
    // détaché à la fermeture (après l'activation éventuelle de l'action)
    popover.connect('closed', () => {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        popover.unparent();
        return GLib.SOURCE_REMOVE;
      });
    });
    popover.popup();
  };

  const click = new Gtk.GestureClick({ button: 3 });
  click.connect('pressed', (gesture: Gtk.GestureClick, _n: number, x: number, y: number) => {
    gesture.set_state(Gtk.EventSequenceState.CLAIMED);
    popup(x, y);
  });
  widget.add_controller(click);

  const longPress = new Gtk.GestureLongPress({ touchOnly: true });
  longPress.connect('pressed', (gesture: Gtk.GestureLongPress, x: number, y: number) => {
    gesture.set_state(Gtk.EventSequenceState.CLAIMED);
    popup(x, y);
  });
  widget.add_controller(longPress);
}
