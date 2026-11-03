// Vue d'un diff unifié présentée comme du code (GtkSourceView) : coloration syntaxique du langage
// du fichier, lignes ajoutées / retirées sur fond coloré, numéros de ligne ancien / nouveau en marge,
// séparateur discret à la place des en-têtes `@@`.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import GtkSource from 'gi://GtkSource?version=5';
import Pango from 'gi://Pango';
import { atAnchor, diffMarkers, parsePatch, selectionOf, type DiffAnchor, type DiffKind as Kind, type DiffLine, type DiffMarker, type DiffSelection, markerY, valueAtMarker, type ScrollTrack } from '../shared/diff.ts';

const MARKER_COLORS: Readonly<Record<DiffMarker['kind'], [number, number, number]>> = {
  add: [0.18, 0.76, 0.49],
  del: [0.88, 0.11, 0.14],
  change: [0.21, 0.52, 0.89],
};

/** Premier descendant de nom CSS `name` (gouttière, curseur de la barre de défilement). */
function descendant(widget: Gtk.Widget, name: string): Gtk.Widget | null {
  for (let c = widget.get_first_child(); c !== null; c = c.get_next_sibling()) {
    if (c.get_css_name() === name) return c;
    const found = descendant(c, name);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Bande étroite à droite du diff : un trait par bloc modifié (vert ajout, rouge suppression, bleu
 * modification), aligné sur la barre de défilement : quand le curseur passe sur un repère, le bloc
 * est à l'écran. Un clic y fait défiler (#162).
 */
function markerStrip(scrolled: Gtk.ScrolledWindow, view: Gtk.TextView, markersOf: () => readonly DiffMarker[]): Gtk.DrawingArea {
  const label = 'Modifications du fichier : clic pour y aller';
  const area = new Gtk.DrawingArea({ widthRequest: 10, vexpand: true, accessibleRole: Gtk.AccessibleRole.IMG, cssClasses: ['diff-markers'], tooltipText: label, cursor: Gdk.Cursor.new_from_name('pointer', null) });
  area.update_property([Gtk.AccessibleProperty.LABEL], [label]);
  /** gouttière et curseur de la barre verticale, dans les coordonnées de la bande */
  const track = (height: number, upper: number, page: number): ScrollTrack => {
    const bar = scrolled.get_vscrollbar();
    const trough = descendant(bar, 'trough');
    const slider = descendant(bar, 'slider');
    if (trough !== null && slider !== null && trough.get_height() > 0) {
      const [ok, rect] = trough.compute_bounds(area);
      if (ok) return { top: rect.get_y(), height: rect.get_height(), slider: slider.get_height() };
    }
    return { top: 0, height, slider: upper > 0 ? (page / upper) * height : 0 };
  };
  area.set_draw_func((_a, cr, width, height) => {
    const adj = view.get_vadjustment();
    if (adj === null) return;
    const upper = adj.get_upper();
    const page = adj.get_page_size();
    const t = track(height, upper, page);
    const buffer = view.get_buffer();
    for (const m of markersOf()) {
      const [red, green, blue] = MARKER_COLORS[m.kind];
      cr.setSourceRGBA(red, green, blue, 0.9);
      const [, first] = buffer.get_iter_at_line(m.start);
      const [, last] = buffer.get_iter_at_line(m.end - 1);
      const [top] = view.get_line_yrange(first);
      const [lastTop, lastHeight] = view.get_line_yrange(last);
      const y0 = markerY(top, upper, page, t);
      const y1 = markerY(lastTop + lastHeight, upper, page, t);
      // trait visible même pour une seule ligne d'un long fichier
      cr.rectangle(2, Math.min(y0, height - 3), width - 4, Math.max(3, y1 - y0));
      cr.fill();
    }
  });
  // contenu mis en page (validé par morceaux) ou redimensionné : positions à recalculer
  view.get_vadjustment()?.connect('changed', () => area.queue_draw());
  const click = new Gtk.GestureClick();
  click.connect('pressed', (_g: Gtk.GestureClick, _n: number, _x: number, y: number) => {
    const adj = view.get_vadjustment();
    if (adj === null) return;
    const upper = adj.get_upper();
    const page = adj.get_page_size();
    adj.set_value(valueAtMarker(y, upper, page, track(area.get_height(), upper, page)));
  });
  area.add_controller(click);
  return area;
}

/** Diff défilant et bande des repères à sa droite. */
function withStrip(scrolled: Gtk.ScrolledWindow, strip: Gtk.Widget): Gtk.Widget {
  const box = new Gtk.Box({ vexpand: true });
  box.append(scrolled);
  box.append(strip);
  return box;
}

/** Au-delà, le diff est tronqué (#160). */
const MAX_LINES = 20_000;
/** Au-delà, pas de coloration syntaxique (#160). */
const HIGHLIGHT_LINES = 5000;

/** Marge : numéro ancien, numéro nouveau, signe. */
const NumbersRenderer = GObject.registerClass(
  class NumbersRenderer extends GtkSource.GutterRendererText {
    diffLines: readonly (DiffLine | null)[] = [];
    /** chiffres du plus grand numéro de ligne (calculé une fois : #76) */
    digits = 1;

    setLines(lines: readonly (DiffLine | null)[]): void {
      this.diffLines = lines;
      const max = lines.reduce((m, l) => Math.max(m, l?.old ?? 0, l?.new ?? 0), 0);
      this.digits = String(max).length;
      const sample = `${'0'.repeat(String(max).length)} ${'0'.repeat(String(max).length)} +`;
      // mesuré avec la police de la vue (celle du rendu de la marge)
      const [width] = this.get_view().create_pango_layout(sample).get_pixel_size();
      this.widthRequest = width + 2 * this.xpad + 4;
      this.queue_draw();
    }

    override vfunc_query_data(_lines: GtkSource.GutterLines, line: number): void {
      const l = this.diffLines[line];
      if (l === undefined || l === null || l.kind === 'hunk' || l.kind === 'meta') {
        this.set_text('', -1);
        return;
      }
      const w = this.digits;
      const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
      this.set_text(`${String(l.old ?? '').padStart(w)} ${String(l.new ?? '').padStart(w)} ${sign}`, -1);
    }
  },
);
type NumbersRenderer = InstanceType<typeof NumbersRenderer>;

export interface DiffView {
  readonly widget: Gtk.Widget;
  show: (filename: string, patch: string) => void;
  /** lignes sélectionnées (ou ligne du curseur), null si rien de commentable */
  readonly selection: () => DiffSelection | null;
  /** appelé quand la sélection change (bouton « Commenter ») */
  readonly onSelectionChanged: (fn: () => void) => void;
  /** commentaires à afficher sous leurs lignes (fichier affiché) ; relu par `refresh()` */
  readonly setAnnotations: (fn: (file: string) => readonly DiffAnnotation[]) => void;
  /** réaffiche le diff courant (commentaires ajoutés ou modifiés) en gardant la position */
  readonly refresh: () => void;
  /** fait défiler jusqu'à une ligne (commentaire de la revue) */
  readonly reveal: (anchor: DiffAnchor) => void;
  /** entrée « Commenter la sélection » du menu contextuel */
  readonly setCommentAction: (fn: (() => void) | null) => void;
}

const noAnnotations = (): readonly DiffAnnotation[] => [];

/** Commentaire affiché sous une ligne du diff. */
export interface DiffAnnotation {
  readonly end: DiffAnchor;
  readonly text: string;
  readonly onClick?: () => void;
}

/**
 * `inline` : vue intégrée au flux d'une conversation (hauteur naturelle, lignes repliées, pas de
 * défilement propre) ; sinon vue défilante qui occupe la place disponible.
 */
export function createDiffView({ inline = false }: { inline?: boolean } = {}): DiffView {
  const buffer = new GtkSource.Buffer({ highlightMatchingBrackets: false });
  const view = new GtkSource.View({
    buffer,
    editable: false,
    cursorVisible: false,
    monospace: true,
    showLineNumbers: false,
    wrapMode: inline ? Gtk.WrapMode.WORD_CHAR : Gtk.WrapMode.NONE,
    topMargin: inline ? 4 : 8,
    bottomMargin: inline ? 6 : 12,
    leftMargin: 8,
    rightMargin: 12,
    cssClasses: inline ? ['diff-view', 'diff-inline'] : ['diff-view'],
  });
  const numbers: NumbersRenderer = new NumbersRenderer({ xalign: 1, xpad: 8, cssClasses: ['diff-numbers'] });
  view.get_gutter(Gtk.TextWindowType.LEFT).insert(numbers, 0);

  // schéma de couleurs qui suit le thème clair / sombre
  const schemes = GtkSource.StyleSchemeManager.get_default();
  const style = Adw.StyleManager.get_default();
  const applyScheme = (): void => {
    const scheme = schemes.get_scheme(style.dark ? 'Adwaita-dark' : 'Adwaita');
    if (scheme !== null) buffer.styleScheme = scheme;
  };
  applyScheme();
  const handler = style.connect('notify::dark', applyScheme);
  view.connect('destroy', () => style.disconnect(handler));

  const table = buffer.get_tag_table();
  const tag = (name: string, props: Partial<Gtk.TextTag.ConstructorProps>): Gtk.TextTag => {
    const t = new Gtk.TextTag({ name, ...props });
    table.add(t);
    return t;
  };
  const tags: Readonly<Record<Kind, Gtk.TextTag | null>> = {
    add: null,
    del: null,
    hunk: tag('hunk', { foreground: '#888888', style: 2 /* Pango.Style.ITALIC */, pixelsAboveLines: 6, pixelsBelowLines: 2 }),
    meta: tag('meta', { foreground: '#888888', style: 2 }),
    ctx: null,
  };
  // fond des lignes : marques (toute la largeur, lignes vides comprises)
  const BACKGROUND: Partial<Record<Kind, string>> = { add: 'rgba(46,194,126,0.16)', del: 'rgba(224,27,36,0.14)', hunk: 'rgba(53,132,228,0.08)' };
  for (const [kind, color] of Object.entries(BACKGROUND)) {
    const rgba = new Gdk.RGBA();
    rgba.parse(color);
    view.set_mark_attributes(kind, new GtkSource.MarkAttributes({ background: rgba }), 0);
  }

  // la coloration syntaxique crée ses étiquettes plus tard (priorité plus haute) : les nôtres repassent au-dessus
  const raise = (): void => {
    const top = table.get_size() - 1;
    for (const t of [tags.hunk, tags.meta]) t?.set_priority(top);
  };
  buffer.connect('highlight-updated', raise);

  let shownFile = '';
  let shownPatch = '';
  /** lignes affichées : lignes du diff, et une ligne par commentaire (null) sous la ligne commentée */
  let shownLines: readonly (DiffLine | null)[] = [];
  let annotationsOf: (file: string) => readonly DiffAnnotation[] = noAnnotations;
  let markers: readonly DiffMarker[] = [];
  /** repères des modifications le long de la barre de défilement (vue défilante seulement) */
  const scrolled = inline ? null : new Gtk.ScrolledWindow({ child: view, vexpand: true, hexpand: true });
  const strip = scrolled === null ? null : markerStrip(scrolled, view, () => markers);
  const show = (filename: string, patch: string, keepPosition = false): void => {
    const parsed = parsePatch(patch);
    // très gros diff (fichier généré, lockfile…) : affichage plafonné (#160)
    const diffLines = parsed.length > MAX_LINES ? [...parsed.slice(0, MAX_LINES), { kind: 'hunk' as const, text: `… ${parsed.length - MAX_LINES} lignes de plus non affichées (diff trop volumineux)` }] : parsed;
    const notes = annotationsOf(filename);
    const rows: (DiffLine | null)[] = [];
    const rowNotes = new Map<number, DiffAnnotation[]>();
    for (const l of diffLines) {
      rows.push(l);
      if (notes.length === 0) continue;
      const here = notes.filter((n) => atAnchor(l, n.end));
      if (here.length > 0) {
        rows.push(null);
        rowNotes.set(rows.length - 1, here);
      }
    }
    const lines = rows;
    const scroll = view.get_vadjustment()?.get_value() ?? 0;
    shownFile = filename;
    shownPatch = patch;
    shownLines = lines;
    buffer.language = GtkSource.LanguageManager.get_default().guess_language(filename, null);
    // coloration syntaxique coûteuse sur un gros diff : désactivée au-delà de HIGHLIGHT_LINES
    buffer.highlightSyntax = buffer.language !== null && lines.length <= HIGHLIGHT_LINES;
    buffer.set_text(lines.map((l) => l?.text ?? '').join('\n'), -1);
    // commentaires : un widget ancré sur leur ligne (vide), sous la ligne commentée
    for (const [i, list] of rowNotes) {
      const [, at] = buffer.get_iter_at_line(i);
      const anchor = buffer.create_child_anchor(at);
      view.add_child_at_anchor(annotationWidget(list), anchor);
    }
    buffer.remove_source_marks(buffer.get_start_iter(), buffer.get_end_iter(), null);
    for (const [i, l] of lines.entries()) {
      if (l === null) continue;
      if (BACKGROUND[l.kind] !== undefined) buffer.create_source_mark(null, l.kind, buffer.get_iter_at_line(i)[1]);
      const t = tags[l.kind];
      if (t === null) continue;
      const [, start] = buffer.get_iter_at_line(i);
      const end = start.copy();
      if (!end.ends_line()) end.forward_to_line_end();
      // ligne vide : on étiquette le saut de ligne (fond du paragraphe)
      if (start.equal(end)) end.forward_char();
      buffer.apply_tag(t, start, end);
    }
    raise();
    numbers.setLines(lines);
    markers = diffMarkers(lines);
    strip?.queue_draw();
    buffer.place_cursor(buffer.get_start_iter());
    if (inline) return;
    const adj = view.get_vadjustment();
    if (keepPosition) {
      // après la mise en page : même position qu'avant
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        adj?.set_value(scroll);
        return GLib.SOURCE_REMOVE;
      });
    } else adj?.set_value(0);
  };

  /** Carte d'un ou plusieurs commentaires sous une ligne (clic : le commentaire dans la revue). */
  const annotationWidget = (list: readonly DiffAnnotation[]): Gtk.Widget => {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, cssClasses: ['diff-annotation'] });
    for (const n of list) {
      const row = new Gtk.Box({ spacing: 8 });
      row.append(new Gtk.Image({ iconName: 'chat-message-new-symbolic', valign: Gtk.Align.START, cssClasses: ['accent'] }));
      row.append(new Gtk.Label({ label: n.text, xalign: 0, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, hexpand: true, selectable: false }));
      box.append(row);
      if (n.onClick !== undefined) {
        const click = new Gtk.GestureClick();
        const fn = n.onClick;
        click.connect('released', () => fn());
        row.add_controller(click);
        row.set_cursor_from_name('pointer');
        row.tooltipText = 'Voir dans la revue';
      }
    }
    // largeur : celle de la vue (moins la marge des numéros)
    const fit = (): void => {
      box.widthRequest = Math.max(200, view.get_width() - numbers.widthRequest - 60);
    };
    fit();
    view.connect('notify::width', fit);
    return box;
  };

  const reveal = (anchor: DiffAnchor): void => {
    const i = shownLines.findIndex((l) => l !== null && atAnchor(l, anchor));
    if (i < 0) return;
    // après la mise en page du diff qui vient d'être affiché
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
      const [, it] = buffer.get_iter_at_line(i);
      buffer.place_cursor(it);
      view.scroll_to_iter(it, 0, true, 0, 0.3);
      return GLib.SOURCE_REMOVE;
    });
  };

  // menu contextuel : « Commenter la sélection »
  let commentAction: (() => void) | null = null;
  const actions = new Gio.SimpleActionGroup();
  const commentGAction = new Gio.SimpleAction({ name: 'comment', enabled: false });
  commentGAction.connect('activate', () => commentAction?.());
  actions.add_action(commentGAction);
  view.insert_action_group('review', actions);
  const extra = new Gio.Menu();
  extra.append('Commenter la sélection…', 'review.comment');

  const selection = (): DiffSelection | null => {
    if (shownFile === '' || !buffer.get_has_selection()) return null;
    const [, a, b] = buffer.get_selection_bounds();
    // fin de sélection en début de ligne : la ligne n'est pas comprise
    const end = b.get_line_offset() === 0 && b.get_line() > a.get_line() ? b.get_line() - 1 : b.get_line();
    const picked = shownLines.slice(a.get_line(), end + 1).filter((l): l is DiffLine => l !== null);
    return selectionOf(shownFile, picked, 0, picked.length - 1);
  };
  const listeners: (() => void)[] = [];
  buffer.connect('notify::has-selection', () => {
    commentGAction.enabled = commentAction !== null && selection() !== null;
    for (const fn of listeners) fn();
  });

  return {
    widget: scrolled === null || strip === null ? view : withStrip(scrolled, strip),
    show,
    selection,
    onSelectionChanged: (fn) => {
      listeners.push(fn);
    },
    setAnnotations: (fn) => {
      annotationsOf = fn;
    },
    refresh: () => {
      if (shownFile !== '') show(shownFile, shownPatch, true);
    },
    reveal,
    setCommentAction: (fn) => {
      commentAction = fn;
      view.extraMenu = fn === null ? null : extra;
    },
  };
}
