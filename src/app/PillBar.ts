// Barres de pastilles (terminaux, liens) : défilement horizontal sans barre par-dessus les
// boutons, et réordonnancement par glisser-déposer (#144).
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

/** espace réservé sous les pastilles pour la barre de défilement (élargie au survol) */
const SCROLLBAR_SPACE = 16;

/**
 * Zone défilante horizontale d'une barre de pastilles. Quand les pastilles débordent, un espace
 * est réservé sous elles pour la barre de défilement, qui ne recouvre plus les boutons au survol ;
 * la molette verticale fait défiler horizontalement.
 */
export function pillScroller(child: unknown): Gtk.ScrolledWindow {
  if (!(child instanceof Gtk.Widget)) throw new TypeError('widget attendu');
  const sw = new Gtk.ScrolledWindow({
    child,
    hexpand: false,
    vscrollbarPolicy: Gtk.PolicyType.NEVER,
    hscrollbarPolicy: Gtk.PolicyType.AUTOMATIC,
    propagateNaturalWidth: true,
    cssClasses: ['pill-scroller'],
  });
  // pastilles en haut de la zone, l'espace réservé en dessous
  child.valign = Gtk.Align.START;
  const adj = sw.get_hadjustment();
  // différé : changer une marge pendant l'allocation (notifications de l'ajustement) la fausse
  let queued = false;
  const reserve = (): void => {
    if (queued) return;
    queued = true;
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      queued = false;
      // zone agrandie (pas les pastilles réduites) : hauteur naturelle des pastilles + l'espace ;
      // heightRequest et non minContentHeight, ignoré sans défilement vertical
      const [, natural] = child.measure(Gtk.Orientation.VERTICAL, -1);
      const height = adj.upper > adj.pageSize + 1 ? natural + SCROLLBAR_SPACE : -1;
      if (sw.heightRequest !== height) sw.heightRequest = height;
      return GLib.SOURCE_REMOVE;
    });
  };
  adj.connect('changed', reserve);
  adj.connect('notify::page-size', reserve);
  adj.connect('notify::upper', reserve);
  const wheel = new Gtk.EventControllerScroll({ flags: Gtk.EventControllerScrollFlags.VERTICAL });
  wheel.connect('scroll', (_c: Gtk.EventControllerScroll, _dx: number, dy: number) => {
    if (adj.upper <= adj.pageSize) return false;
    adj.value = Math.max(adj.lower, Math.min(adj.upper - adj.pageSize, adj.value + dy * 40));
    return true;
  });
  sw.add_controller(wheel);
  return sw;
}

export interface ReorderOptions {
  /** clés des pastilles de la même liste, dans l'ordre affiché */
  readonly order: () => readonly string[];
  /** déplace `key` avant `before` (à la fin si null) dans cette liste */
  readonly move: (key: string, before: string | null) => void;
  /** dossier : déposer au milieu de la pastille range `key` dedans ; false si refusé */
  readonly into?: (key: string) => boolean;
  /** début et fin du glisser (ex. menu d'un dossier) */
  readonly dragBegin?: () => void;
  readonly dragEnd?: () => void;
  /** liste verticale (menu d'un dossier) : avant / après selon la moitié haute / basse */
  readonly vertical?: boolean;
}

const TAG = 'pill:';

/** Accepte les dépôts en fin de liste sur `widget` (zone vide après les pastilles). */
export function dropAtEnd(widget: Gtk.Widget, move: (key: string) => void): void {
  const target = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
  target.connect('drop', (_t: Gtk.DropTarget, value: unknown) => {
    if (typeof value !== 'string' || !value.startsWith(TAG)) return false;
    move(value.slice(TAG.length));
    return true;
  });
  widget.add_controller(target);
}

/**
 * Pastille réordonnable (clé `key`) : glissée sur une autre pastille, elle se place avant elle
 * (moitié gauche) ou après (moitié droite) ; sur un dossier (`into`), le milieu la range dedans.
 */
export function reorderable(widget: Gtk.Widget, key: string, opts: ReorderOptions): void {
  const source = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE, propagationPhase: Gtk.PropagationPhase.CAPTURE });
  source.connect('prepare', () => Gdk.ContentProvider.new_for_value(TAG + key));
  source.connect('drag-begin', () => {
    source.set_icon(Gtk.WidgetPaintable.new(widget), 20, 10);
    widget.add_css_class('dragging');
    opts.dragBegin?.();
  });
  source.connect('drag-end', () => {
    widget.remove_css_class('dragging');
    opts.dragEnd?.();
  });
  widget.add_controller(source);
  // la barre est dans une poignée de fenêtre (barre du haut d'Adw.ToolbarView) : au même seuil,
  // elle déplaçait la fenêtre avant que le glisser ne démarre. Un geste groupé avec la source
  // réclame la séquence dès quelques pixels : la poignée et le clic du bouton sont annulés, la
  // source (même groupe) continue. Un simple clic reste un clic.
  const claim = new Gtk.GestureDrag({ propagationPhase: Gtk.PropagationPhase.CAPTURE });
  claim.connect('drag-update', (_g: Gtk.GestureDrag, dx: number, dy: number) => {
    if (Math.abs(dx) + Math.abs(dy) > 3) claim.set_state(Gtk.EventSequenceState.CLAIMED);
  });
  widget.add_controller(claim);
  claim.group(source);

  const target = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
  const CLASSES = ['drop-before', 'drop-after', 'drop-into', 'drop-above', 'drop-below'];
  type Zone = 'drop-before' | 'drop-after' | 'drop-into';
  const zone = (x: number, y: number): Zone => {
    const pos = opts.vertical === true ? y : x;
    const w = opts.vertical === true ? widget.get_height() : widget.get_width();
    if (opts.into !== undefined && pos > w / 4 && pos < (w * 3) / 4) return 'drop-into';
    return pos < w / 2 ? 'drop-before' : 'drop-after';
  };
  /** classe du repère : trait à gauche / droite, ou en haut / bas d'une liste verticale */
  const cls = (z: Zone): string => (opts.vertical === true && z !== 'drop-into' ? (z === 'drop-before' ? 'drop-above' : 'drop-below') : z);
  const clear = (): void => {
    for (const c of CLASSES) widget.remove_css_class(c);
  };
  const mark = (x: number, y: number): Gdk.DragAction => {
    const c = cls(zone(x, y));
    for (const other of CLASSES) if (other !== c) widget.remove_css_class(other);
    widget.add_css_class(c);
    return Gdk.DragAction.MOVE;
  };
  target.connect('enter', (_t: Gtk.DropTarget, x: number, y: number) => mark(x, y));
  target.connect('motion', (_t: Gtk.DropTarget, x: number, y: number) => mark(x, y));
  target.connect('leave', clear);
  target.connect('drop', (_t: Gtk.DropTarget, value: unknown, x: number, y: number) => {
    clear();
    if (typeof value !== 'string' || !value.startsWith(TAG)) return false;
    const moved = value.slice(TAG.length);
    if (moved === key) return false;
    const z = zone(x, y);
    if (z === 'drop-into') return opts.into?.(moved) ?? false;
    const ids = opts.order();
    const at = ids.indexOf(key);
    // moitié droite : avant la pastille suivante (sans compter celle déplacée)
    const before = z === 'drop-before' ? key : (ids.slice(at + 1).find((k) => k !== moved) ?? null);
    opts.move(moved, before);
    return true;
  });
  widget.add_controller(target);
}
