// Vue d'un diff unifié présentée comme du code (GtkSourceView) : coloration syntaxique du langage
// du fichier, lignes ajoutées / retirées sur fond coloré, numéros de ligne ancien / nouveau en marge,
// séparateur discret à la place des en-têtes `@@`.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import GtkSource from 'gi://GtkSource?version=5';

const MAX_PATCH = 200_000;

type Kind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

interface DiffLine {
  readonly kind: Kind;
  readonly text: string;
  readonly old?: number;
  readonly new?: number;
}

/** Découpe un patch unifié en lignes (sans les entêtes `diff --git`, `index`, `---`, `+++`). */
export function parsePatch(patch: string): DiffLine[] {
  const text = patch.length > MAX_PATCH ? patch.slice(0, MAX_PATCH) : patch;
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of text.split('\n')) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/u.exec(line);
    if (h !== null) {
      oldNo = Number(h[1]);
      newNo = Number(h[3]);
      const count = Number(h[4] ?? '1');
      const range = count <= 1 ? `ligne ${newNo}` : `lignes ${newNo}–${newNo + count - 1}`;
      const context = (h[5] ?? '').trim();
      out.push({ kind: 'hunk', text: context === '' ? range : `${range} · ${context}` });
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // entêtes du fichier
    if (line.startsWith('+')) out.push({ kind: 'add', text: line.slice(1), new: newNo++ });
    else if (line.startsWith('-')) out.push({ kind: 'del', text: line.slice(1), old: oldNo++ });
    else if (line.startsWith('\\')) out.push({ kind: 'meta', text: line.slice(2) });
    else if (line.startsWith(' ')) out.push({ kind: 'ctx', text: line.slice(1), old: oldNo++, new: newNo++ });
  }
  if (patch.length > MAX_PATCH) out.push({ kind: 'meta', text: '… diff tronqué' });
  return out;
}

/** Marge : numéro ancien, numéro nouveau, signe. */
const NumbersRenderer = GObject.registerClass(
  class NumbersRenderer extends GtkSource.GutterRendererText {
    diffLines: readonly DiffLine[] = [];

    setLines(lines: readonly DiffLine[]): void {
      this.diffLines = lines;
      const max = lines.reduce((m, l) => Math.max(m, l.old ?? 0, l.new ?? 0), 0);
      const sample = `${'0'.repeat(String(max).length)} ${'0'.repeat(String(max).length)} +`;
      // mesuré avec la police de la vue (celle du rendu de la marge)
      const [width] = this.get_view().create_pango_layout(sample).get_pixel_size();
      this.widthRequest = width + 2 * this.xpad + 4;
      this.queue_draw();
    }

    override vfunc_query_data(_lines: GtkSource.GutterLines, line: number): void {
      const l = this.diffLines[line];
      if (l === undefined || l.kind === 'hunk' || l.kind === 'meta') {
        this.set_text('', -1);
        return;
      }
      const w = String(this.diffLines.reduce((m, x) => Math.max(m, x.old ?? 0, x.new ?? 0), 0)).length;
      const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
      this.set_text(`${String(l.old ?? '').padStart(w)} ${String(l.new ?? '').padStart(w)} ${sign}`, -1);
    }
  },
);
type NumbersRenderer = InstanceType<typeof NumbersRenderer>;

export interface DiffView {
  readonly widget: Gtk.Widget;
  show: (filename: string, patch: string) => void;
}

export function createDiffView(): DiffView {
  const buffer = new GtkSource.Buffer({ highlightMatchingBrackets: false });
  const view = new GtkSource.View({
    buffer,
    editable: false,
    cursorVisible: false,
    monospace: true,
    showLineNumbers: false,
    wrapMode: Gtk.WrapMode.NONE,
    topMargin: 8,
    bottomMargin: 12,
    leftMargin: 8,
    rightMargin: 12,
    cssClasses: ['diff-view'],
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

  const show = (filename: string, patch: string): void => {
    const lines = parsePatch(patch);
    buffer.language = GtkSource.LanguageManager.get_default().guess_language(filename, null);
    buffer.highlightSyntax = buffer.language !== null;
    buffer.set_text(lines.map((l) => l.text).join('\n'), -1);
    buffer.remove_source_marks(buffer.get_start_iter(), buffer.get_end_iter(), null);
    for (const [i, l] of lines.entries()) {
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
    buffer.place_cursor(buffer.get_start_iter());
    view.get_vadjustment()?.set_value(0);
  };

  return { widget: new Gtk.ScrolledWindow({ child: view, vexpand: true }), show };
}
