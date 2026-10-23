// Liste de complétion du compositeur (commandes « / », mentions « @ »).
// Popover sans focus ancré au curseur : la saisie continue dans la zone de texte, qui relaie
// Haut / Bas / Tab / Entrée / Échap à la liste tant qu'elle est ouverte.
import Gdk from 'gi://Gdk?version=4.0';
import type Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

export interface CompletionItem {
  readonly title: string;
  /** texte secondaire (description, dossier), atténué, sur une ligne */
  readonly subtitle?: string;
  /** étiquette à droite (« skill », « intégrée »…) */
  readonly badge?: string;
  readonly icon?: Gio.Icon;
  /** appliquée à la validation (Tab, Entrée, clic) */
  readonly accept: () => void;
}

const MAX_HEIGHT = 280;
const WIDTH = 460;

export class CompletionPopover {
  readonly #view: Gtk.TextView;
  readonly #popover: Gtk.Popover;
  readonly #list: Gtk.ListBox;
  readonly #scrolled: Gtk.ScrolledWindow;
  #items: readonly CompletionItem[] = [];

  constructor(view: Gtk.TextView) {
    this.#view = view;
    this.#list = new Gtk.ListBox({
      selectionMode: Gtk.SelectionMode.BROWSE,
      cssClasses: ['completion-list'],
    });
    this.#list.connect('row-activated', (_l: Gtk.ListBox, row: Gtk.ListBoxRow) => this.#accept(row.get_index()));
    this.#scrolled = new Gtk.ScrolledWindow({
      hscrollbarPolicy: Gtk.PolicyType.NEVER,
      propagateNaturalHeight: true,
      maxContentHeight: MAX_HEIGHT,
      child: this.#list,
    });
    this.#popover = new Gtk.Popover({
      child: this.#scrolled,
      autohide: false,
      hasArrow: false,
      canFocus: false,
      focusable: false,
      position: Gtk.PositionType.TOP,
      halign: Gtk.Align.START,
      widthRequest: WIDTH,
      cssClasses: ['completion'],
    });
    this.#popover.set_parent(view);
    view.connect('destroy', () => this.#popover.unparent());
    // la zone de saisie perd le focus (clic ailleurs) : la liste se ferme
    const focus = new Gtk.EventControllerFocus();
    focus.connect('leave', () => this.hide());
    view.add_controller(focus);
  }

  get open(): boolean {
    return this.#popover.visible;
  }

  /** Affiche `items` au-dessus de la position `at` du texte ; ferme la liste si elle est vide. */
  show(items: readonly CompletionItem[], at: Gtk.TextIter): void {
    if (items.length === 0) {
      this.hide();
      return;
    }
    this.#items = items;
    this.#list.remove_all();
    for (const item of items) this.#list.append(makeRow(item));
    const [, natural] = this.#list.measure(Gtk.Orientation.VERTICAL, WIDTH);
    // une barre de défilement impose une hauteur minimale : seulement si la liste déborde
    this.#scrolled.vscrollbarPolicy = natural > MAX_HEIGHT ? Gtk.PolicyType.AUTOMATIC : Gtk.PolicyType.NEVER;
    // la surface d'un popover ouvert ne rétrécit pas : réouverture quand la liste raccourcit
    if (this.#popover.visible && Math.min(natural, MAX_HEIGHT) < this.#scrolled.get_height()) this.#popover.popdown();
    this.#select(0);
    const loc = this.#view.get_iter_location(at);
    const [x, y] = this.#view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, loc.x, loc.y);
    this.#popover.set_pointing_to(new Gdk.Rectangle({ x, y, width: 1, height: loc.height }));
    if (this.#popover.visible) this.#popover.present();
    else this.#popover.popup();
  }

  hide(): void {
    if (this.#popover.visible) this.#popover.popdown();
  }

  /** Touche de la zone de saisie : true si la liste l'a consommée. */
  key(keyval: number, state: Gdk.ModifierType): boolean {
    if (!this.open) return false;
    const mods = state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.SHIFT_MASK | Gdk.ModifierType.ALT_MASK);
    const current = this.#list.get_selected_row()?.get_index() ?? 0;
    const n = this.#items.length;
    switch (keyval) {
      case Gdk.KEY_Up:
      case Gdk.KEY_KP_Up:
        this.#select((current - 1 + n) % n);
        return true;
      case Gdk.KEY_Down:
      case Gdk.KEY_KP_Down:
        this.#select((current + 1) % n);
        return true;
      case Gdk.KEY_Page_Up:
        this.#select(Math.max(0, current - 8));
        return true;
      case Gdk.KEY_Page_Down:
        this.#select(Math.min(n - 1, current + 8));
        return true;
      case Gdk.KEY_Tab:
      case Gdk.KEY_ISO_Left_Tab:
        this.#accept(current);
        return true;
      case Gdk.KEY_Return:
      case Gdk.KEY_KP_Enter:
        // Ctrl+Entrée garde son rôle (envoi)
        if (mods !== 0) return false;
        this.#accept(current);
        return true;
      case Gdk.KEY_Escape:
        this.hide();
        return true;
      default:
        return false;
    }
  }

  #select(index: number): void {
    const r = this.#list.get_row_at_index(index);
    if (r === null) return;
    this.#list.select_row(r);
    // garde la ligne visible
    const adj = this.#scrolled.get_vadjustment();
    const [ok, bounds] = r.compute_bounds(this.#list);
    if (!ok) return;
    const top = bounds.get_y();
    const bottom = top + bounds.get_height();
    if (top < adj.value) adj.value = top;
    else if (bottom > adj.value + adj.pageSize) adj.value = bottom - adj.pageSize;
  }

  #accept(index: number): void {
    const item = this.#items[index];
    this.hide();
    item?.accept();
    this.#view.grab_focus();
  }
}

function makeRow(item: CompletionItem): Gtk.ListBoxRow {
  const box = new Gtk.Box({
    spacing: 8,
    marginStart: 6,
    marginEnd: 6,
    marginTop: 3,
    marginBottom: 3,
  });
  if (item.icon !== undefined) box.append(new Gtk.Image({ gicon: item.icon }));
  box.append(
    new Gtk.Label({
      label: item.title,
      xalign: 0,
      cssClasses: ['heading'],
      ellipsize: Pango.EllipsizeMode.MIDDLE,
      maxWidthChars: 32,
    }),
  );
  box.append(
    new Gtk.Label({
      label: item.subtitle ?? '',
      xalign: 0,
      hexpand: true,
      ellipsize: Pango.EllipsizeMode.END,
      widthChars: 1,
      cssClasses: ['dim-label', 'caption'],
      tooltipText: item.subtitle ?? '',
    }),
  );
  if (item.badge !== undefined)
    box.append(
      new Gtk.Label({
        label: item.badge,
        cssClasses: ['completion-badge', 'caption'],
      }),
    );
  return new Gtk.ListBoxRow({ child: box, focusable: false });
}
