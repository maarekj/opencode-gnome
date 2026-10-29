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
 * Nom accessible des entrées d'un menu (GtkModelButton) : GTK 4 ne l'expose pas, les lecteurs
 * d'écran (et les tests e2e) ne voient que des entrées sans nom. Appelée à l'affichage du menu.
 */
export function labelMenuItems(popover: Gtk.Popover): void {
  const walk = (w: Gtk.Widget): void => {
    if (w.get_css_name() === 'modelbutton') {
      const text: unknown = Reflect.get(w, 'text');
      if (typeof text === 'string' && text !== '') {
        // le libellé interne (« labelled-by ») prendrait le pas sur le nom
        w.reset_relation(Gtk.AccessibleRelation.LABELLED_BY);
        w.update_property([Gtk.AccessibleProperty.LABEL], [text.replaceAll('_', '')]);
      }
    }
    for (let c = w.get_first_child(); c !== null; c = c.get_next_sibling()) walk(c);
  };
  walk(popover);
}

/** Menus des boutons à menu (`menuModel` déjà posé) : entrées nommées à chaque ouverture. */
export function labelMenuButton(button: { readonly popover: Gtk.Popover | null }): void {
  const popover = button.popover;
  popover?.connect('show', () => labelMenuItems(popover));
}

/**
 * Menu contextuel d'un élément affiché dans un autre menu (ex. menu d'un dossier) : ce menu est
 * fermé avant chaque action, et les dialogues se rattachent à `anchor` (hors du menu) — sinon le
 * menu garde le focus et le dialogue est inutilisable (#146).
 */
export interface MenuHost {
  readonly anchor: Gtk.Widget;
  readonly close: () => void;
}

/** Sections dont chaque action ferme d'abord le menu hôte. */
export function hosted(host: MenuHost | undefined, sections: readonly (readonly MenuItem[])[]): readonly (readonly MenuItem[])[] {
  if (host === undefined) return sections;
  return sections.map((items) =>
    items.map((i) => ({
      label: i.label,
      activate: () => {
        host.close();
        i.activate();
      },
    })),
  );
}

/** menus ouverts, et fonctions à appeler quand ils sont tous refermés */
const openMenus = new Set<Gtk.Popover>();
const waiters: (() => void)[] = [];

/** Un menu contextuel est-il ouvert sur `widget` ou l'un de ses descendants ? */
export function menuOpenIn(widget: Gtk.Widget): boolean {
  for (const m of openMenus) {
    const parent = m.get_parent();
    if (parent !== null && (parent === widget || parent.is_ancestor(widget))) return true;
  }
  return false;
}

/** Appelle `fn` une fois tous les menus contextuels refermés. */
export function afterMenusClosed(fn: () => void): void {
  if (openMenus.size === 0) fn();
  else waiters.push(fn);
}

/**
 * Ajoute un menu contextuel à `widget`. `sections()` est appelée à chaque ouverture
 * (libellés à jour, ex. « Ajouter / Retirer des favoris ») ; chaque section est séparée par un trait.
 */
export function attachContextMenu(widget: Gtk.Widget, sections: () => readonly (readonly MenuItem[])[], opts: { primary?: boolean } = {}): void {
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
        openMenus.delete(popover);
        if (openMenus.size === 0) for (const fn of waiters.splice(0)) fn();
        return GLib.SOURCE_REMOVE;
      });
    });
    openMenus.add(popover);
    popover.popup();
    labelMenuItems(popover);
  };

  // bouton « ⋮ » : le menu s'ouvre aussi au clic normal, sous le bouton
  if (opts.primary === true && widget instanceof Gtk.Button) {
    widget.connect('clicked', () => popup(widget.get_width() / 2, widget.get_height()));
  }

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
