// Actions sur une session : menu contextuel (clic droit, appui long) et dialogues
// de renommage / suppression.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

export interface SessionActions {
  open: () => void;
  openInTerminal: () => void;
  rename: (title: string) => void;
  fork: () => void;
  delete: () => void;
}

const MENU: readonly (readonly [label: string, action: keyof SessionActions | 'ask-rename' | 'ask-delete'])[] = [
  ['Ouvrir', 'open'],
  ['Ouvrir dans le terminal', 'openInTerminal'],
  ['Renommer…', 'ask-rename'],
  ['Forker', 'fork'],
];

/** Demande un nouveau titre. */
export function askRename(parent: Gtk.Widget, current: string, rename: (title: string) => void): void {
  const entry = new Gtk.Entry({ text: current, activatesDefault: true });
  const dialog = new Adw.AlertDialog({ heading: 'Renommer la session', extraChild: entry, defaultResponse: 'rename', closeResponse: 'cancel' });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('rename', 'Renommer');
  dialog.set_response_appearance('rename', Adw.ResponseAppearance.SUGGESTED);
  dialog.connect('response', (_d: Adw.AlertDialog, response: string) => {
    const title = entry.text.trim();
    if (response === 'rename' && title !== '' && title !== current) rename(title);
  });
  dialog.present(parent);
  entry.grab_focus();
  entry.select_region(0, -1);
}

/** Confirme la suppression. */
export function askDelete(parent: Gtk.Widget, title: string, remove: () => void): void {
  const dialog = new Adw.AlertDialog({
    heading: 'Supprimer la session ?',
    body: `« ${title} » et tout son historique seront supprimés définitivement.`,
    defaultResponse: 'cancel',
    closeResponse: 'cancel',
  });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('delete', 'Supprimer');
  dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
  dialog.connect('response', (_d: Adw.AlertDialog, response: string) => {
    if (response === 'delete') remove();
  });
  dialog.present(parent);
}

/**
 * Ajoute à `widget` un menu contextuel (clic droit, appui long sur écran tactile).
 * `title()` : titre courant de la session (pour les dialogues).
 */
export function attachSessionMenu(widget: Gtk.Widget, title: () => string, actions: SessionActions): void {
  const group = new Gio.SimpleActionGroup();
  const add = (name: string, fn: () => void): void => {
    const action = new Gio.SimpleAction({ name });
    action.connect('activate', fn);
    group.add_action(action);
  };
  add('open', actions.open);
  add('openInTerminal', actions.openInTerminal);
  add('fork', actions.fork);
  add('ask-rename', () => askRename(widget, title(), actions.rename));
  add('ask-delete', () => askDelete(widget, title(), actions.delete));
  widget.insert_action_group('session', group);

  const model = new Gio.Menu();
  const main = new Gio.Menu();
  for (const [label, action] of MENU) main.append(label, `session.${action}`);
  model.append_section(null, main);
  const danger = new Gio.Menu();
  danger.append('Supprimer…', 'session.ask-delete');
  model.append_section(null, danger);

  const popup = (x: number, y: number): void => {
    const popover = Gtk.PopoverMenu.new_from_model(model);
    popover.set_parent(widget);
    popover.hasArrow = false;
    popover.halign = Gtk.Align.START;
    const rect = new Gdk.Rectangle({ x: Math.round(x), y: Math.round(y), width: 1, height: 1 });
    popover.set_pointing_to(rect);
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
