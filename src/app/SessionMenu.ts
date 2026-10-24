// Actions sur une session : menu contextuel et dialogues
// de renommage / suppression.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { attachContextMenu } from './ContextMenu.ts';

export interface SessionActions {
  open: () => void;
  openInTerminal: () => void;
  rename: (title: string) => void;
  fork: () => void;
  delete: () => void;
}

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

const CONFIRM_DELAY = 4000;

/**
 * Bouton corbeille à double clic : le premier clic le transforme en « Supprimer ? » rouge, le second
 * supprime. Sans second clic, il revient à son état normal après quelques secondes ou quand le
 * pointeur quitte le bouton.
 */
export function deleteButton(remove: () => void): Gtk.Button {
  const button = new Gtk.Button({ iconName: 'user-trash-symbolic', tooltipText: 'Supprimer', cssClasses: ['flat', 'delete-button'] });
  let armed = false;
  let timer = 0;
  const reset = (): void => {
    if (timer !== 0) GLib.source_remove(timer);
    timer = 0;
    if (!armed) return;
    armed = false;
    button.iconName = 'user-trash-symbolic';
    button.tooltipText = 'Supprimer';
    button.remove_css_class('destructive-action');
  };
  button.connect('clicked', () => {
    if (armed) {
      reset();
      button.sensitive = false;
      remove();
      return;
    }
    armed = true;
    button.label = 'Supprimer ?';
    button.tooltipText = 'Cliquer à nouveau pour supprimer définitivement';
    button.add_css_class('destructive-action');
    timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CONFIRM_DELAY, () => {
      timer = 0;
      reset();
      return GLib.SOURCE_REMOVE;
    });
  });
  const motion = new Gtk.EventControllerMotion();
  motion.connect('leave', reset);
  button.add_controller(motion);
  button.connect('destroy', () => {
    if (timer !== 0) GLib.source_remove(timer);
    timer = 0;
  });
  return button;
}

/** Menu contextuel d'une session. `title()` : titre courant (pour les dialogues). */
export function attachSessionMenu(widget: Gtk.Widget, title: () => string, actions: SessionActions): void {
  attachContextMenu(widget, () => [
    [
      { label: 'Ouvrir', activate: actions.open },
      { label: 'Ouvrir dans le terminal', activate: actions.openInTerminal },
      { label: 'Renommer…', activate: () => askRename(widget, title(), actions.rename) },
      { label: 'Forker', activate: actions.fork },
    ],
    [{ label: 'Supprimer…', activate: () => askDelete(widget, title(), actions.delete) }],
  ]);
}
