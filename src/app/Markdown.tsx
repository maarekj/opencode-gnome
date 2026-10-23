// Markdown -> Gtk widgets (blocks from src/shared/markdown.ts).
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import { parseMarkdown, type Block } from '../shared/markdown.ts';

/** Sets Pango markup, falling back to plain text if the markup is invalid. */
function setMarkup(label: Gtk.Label, markup: string): void {
  try {
    label.set_markup(markup);
  } catch {
    label.set_text(markup);
  }
}

/** Selectable, wrapping label rendering Pango markup. */
export function MarkupLabel({ markup, css = [], hexpand = false }: { markup: string; css?: string[]; hexpand?: boolean }): JSX.Element {
  return (
    <Gtk.Label
      wrap
      wrapMode={Pango.WrapMode.WORD_CHAR}
      xalign={0}
      selectable
      useMarkup
      hexpand={hexpand}
      cssClasses={css}
      maxWidthChars={-1}
      $={(self) => {
        setMarkup(self, markup);
      }}
    />
  );
}

export function Table({ header, rows }: { header: string[]; rows: string[][] }): JSX.Element {
  // Lignes en Gtk.Box horizontales homogènes (colonnes de même largeur, alignées d'une ligne à
  // l'autre). Ni Gtk.Grid ni ScrolledWindow : ils calculent mal la hauteur des labels repliés.
  const columns = Math.max(header.length, ...rows.map((r) => r.length));
  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={['card', 'md-table']}>
      {[header, ...rows].map((row, y) => (
        <Gtk.Box homogeneous spacing={18}>
          {Array.from({ length: columns }, (_v, x) => (
            <Gtk.Label
              wrap
              wrapMode={Pango.WrapMode.WORD_CHAR}
              xalign={0}
              valign={Gtk.Align.START}
              selectable
              $={(self: Gtk.Label) => {
                const cell = row[x] ?? '';
                setMarkup(self, y === 0 ? `<b>${cell}</b>` : cell);
              }}
            />
          ))}
        </Gtk.Box>
      ))}
    </Gtk.Box>
  );
}

const HEADING_CSS: Readonly<Record<number, string>> = { 1: 'title-2', 2: 'title-3' };

function assertNever(value: never): never {
  throw new Error(`Bloc inattendu: ${JSON.stringify(value)}`);
}

function BlockView({ block: b }: { block: Block }): JSX.Element {
  switch (b.kind) {
    case 'paragraph':
      return <MarkupLabel markup={b.markup} />;
    case 'heading':
      return (
        <Gtk.Box marginTop={6}>
          <MarkupLabel markup={b.markup} css={[HEADING_CSS[b.level] ?? 'heading']} />
        </Gtk.Box>
      );
    case 'item':
      return (
        <Gtk.Box spacing={8} marginStart={6 + b.depth * 18}>
          <Gtk.Label label={b.bullet} valign={Gtk.Align.START} widthChars={3} xalign={1} cssClasses={['dim-label']} />
          <MarkupLabel markup={b.markup} hexpand />
        </Gtk.Box>
      );
    case 'quote':
      return (
        <Gtk.Box spacing={10}>
          <Gtk.Separator orientation={Gtk.Orientation.VERTICAL} />
          <MarkupLabel markup={`<i>${b.markup}</i>`} css={['dim-label']} />
        </Gtk.Box>
      );
    case 'code':
      return (
        <Gtk.Frame>
          <Gtk.Label
            label={b.text}
            xalign={0}
            selectable
            wrap
            wrapMode={Pango.WrapMode.CHAR}
            cssClasses={['monospace']}
            marginTop={8}
            marginBottom={8}
            marginStart={12}
            marginEnd={12}
          />
        </Gtk.Frame>
      );
    case 'table':
      return <Table header={b.header} rows={b.rows} />;
    case 'rule':
      return <Gtk.Separator marginTop={4} marginBottom={4} />;
    default:
      return assertNever(b);
  }
}

export function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
      {parseMarkdown(text).map((block) => (
        <BlockView block={block} />
      ))}
    </Gtk.Box>
  );
}

// ---------------------------------------------------------------- vue texte unique (sélection libre)

/** Les liens Pango (`<a>`) ne sont pas gérés par GtkTextBuffer : rendus comme du texte souligné. */
const ttAsSpan = (markup: string): string =>
  markup
    // <tt> n'est pas appliqué par GtkTextBuffer : police monospace explicite
    .replaceAll('<tt>', '<span font_family="monospace" background="#8080801a">')
    .replaceAll('</tt>', '</span>');

const LINK = /<a href="([^"]*)">(.*?)<\/a>/gu;

/** Lien (TextTag) -> URL, pour les clics. */
const linkUrls = new WeakMap<Gtk.TextTag, string>();

/** Décode les entités échappées par le parseur (`&amp;`…) dans une URL. */
const unescapeUrl = (u: string): string =>
  u.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

/** URL du lien sous la position (x, y) de la vue, s'il y en a un. */
function linkAt(view: Gtk.TextView, x: number, y: number): string | null {
  const [bx, by] = view.window_to_buffer_coords(Gtk.TextWindowType.WIDGET, Math.round(x), Math.round(y));
  const [found, iter] = view.get_iter_at_location(bx, by);
  if (!found) return null;
  for (const tag of iter.get_tags()) {
    const url = linkUrls.get(tag);
    if (url !== undefined) return url;
  }
  return null;
}

/** Rend les liens cliquables : curseur main au survol, ouverture au clic (sans sélection en cours). */
function enableLinks(view: Gtk.TextView): void {
  const motion = new Gtk.EventControllerMotion();
  let hovering = false;
  motion.connect('motion', (_c: Gtk.EventControllerMotion, x: number, y: number) => {
    const on = linkAt(view, x, y) !== null;
    if (on !== hovering) {
      hovering = on;
      view.set_cursor_from_name(on ? 'pointer' : 'text');
    }
  });
  view.add_controller(motion);
  const click = new Gtk.GestureClick({ button: 1 });
  click.connect('released', (_g: Gtk.GestureClick, n: number, x: number, y: number) => {
    if (n !== 1 || view.buffer.get_has_selection()) return;
    const url = linkAt(view, x, y);
    if (url === null) return;
    // tests : le lien est journalisé au lieu d'ouvrir le navigateur
    if (GLib.getenv('OPENCODE_GNOME_TEST_LINKS') !== null) {
      console.log(`LIEN ${url}`);
      return;
    }
    const root = view.get_root();
    new Gtk.UriLauncher({ uri: url }).launch(root instanceof Gtk.Window ? root : null, null, null);
  });
  view.add_controller(click);
}

function tags(buffer: Gtk.TextBuffer): Record<'para' | 'h1' | 'h2' | 'h3' | 'item' | 'quote' | 'code' | 'codeEnd' | 'rule', Gtk.TextTag> {
  const table = buffer.get_tag_table();
  const tag = (name: string, props: Partial<Gtk.TextTag.ConstructorProps>): Gtk.TextTag => {
    const t = new Gtk.TextTag({ name, ...props });
    table.add(t);
    return t;
  };
  return {
    para: tag('para', { pixelsBelowLines: 8 }),
    h1: tag('h1', { scale: 1.45, weight: Pango.Weight.BOLD, pixelsAboveLines: 6, pixelsBelowLines: 8 }),
    h2: tag('h2', { scale: 1.25, weight: Pango.Weight.BOLD, pixelsAboveLines: 6, pixelsBelowLines: 8 }),
    h3: tag('h3', { weight: Pango.Weight.BOLD, pixelsAboveLines: 4, pixelsBelowLines: 6 }),
    item: tag('item', { pixelsBelowLines: 4 }),
    quote: tag('quote', { style: Pango.Style.ITALIC, leftMargin: 14, foreground: '#77767b', pixelsBelowLines: 8 }),
    code: tag('code', { family: 'monospace', paragraphBackground: 'rgba(127,127,127,0.10)', leftMargin: 10, rightMargin: 10, pixelsBelowLines: 0 }),
    // créé après `code` : prioritaire, espace sous la dernière ligne d'un bloc de code
    codeEnd: tag('codeEnd', { pixelsBelowLines: 10 }),
    rule: tag('rule', { foreground: '#9a9996', pixelsBelowLines: 8, justification: Gtk.Justification.CENTER }),
  };
}

/** Insère du markup Pango ; texte brut si le markup est invalide. */
function insertMarkup(buffer: Gtk.TextBuffer, markup: string): void {
  // les <a> ne sont pas gérés par GtkTextBuffer : chaque lien devient un TextTag associé à son URL
  let last = 0;
  for (const m of markup.matchAll(LINK)) {
    insertSpan(buffer, markup.slice(last, m.index));
    const start = buffer.get_char_count();
    insertSpan(buffer, m[2] ?? '');
    const url = unescapeUrl(m[1] ?? '');
    const tag = new Gtk.TextTag({ underline: Pango.Underline.SINGLE, foreground: '#3584e4' });
    buffer.get_tag_table().add(tag);
    linkUrls.set(tag, url);
    buffer.apply_tag(tag, buffer.get_iter_at_offset(start), buffer.get_end_iter());
    last = m.index + m[0].length;
  }
  insertSpan(buffer, markup.slice(last));
}

/** Markup Pango sans lien ; texte sans balises si le markup est invalide. */
function insertSpan(buffer: Gtk.TextBuffer, markup: string): void {
  if (markup === '') return;
  try {
    buffer.insert_markup(buffer.get_end_iter(), ttAsSpan(markup), -1);
  } catch {
    buffer.insert(buffer.get_end_iter(), unescapeUrl(markup.replaceAll(/<[^>]+>/gu, '')), -1);
  }
}

/** Applique `tag` à tout ce qui a été inséré depuis `offset`. */
const tagFrom = (buffer: Gtk.TextBuffer, tag: Gtk.TextTag, offset: number): void => {
  buffer.apply_tag(tag, buffer.get_iter_at_offset(offset), buffer.get_end_iter());
};

/**
 * Markdown rendu dans un seul Gtk.TextView non éditable : la sélection s'étend librement sur
 * tout le message (paragraphes, titres, listes, code). Les tableaux sont des widgets ancrés.
 */
export function MarkdownView({ text }: { text: string }): Gtk.TextView {
  const buffer = new Gtk.TextBuffer();
  const view = new Gtk.TextView({
    buffer,
    editable: false,
    cursorVisible: false,
    wrapMode: Gtk.WrapMode.WORD_CHAR,
    cssClasses: ['markdown-view'],
    hexpand: true,
  });
  const t = tags(buffer);
  enableLinks(view);
  const tables: Gtk.Widget[] = [];
  const blocks = parseMarkdown(text);
  blocks.forEach((b, i) => {
    const start = buffer.get_char_count();
    const last = i === blocks.length - 1;
    switch (b.kind) {
      case 'paragraph':
        insertMarkup(buffer, b.markup);
        tagFrom(buffer, t.para, start);
        break;
      case 'heading':
        insertMarkup(buffer, b.markup);
        tagFrom(buffer, b.level === 1 ? t.h1 : b.level === 2 ? t.h2 : t.h3, start);
        break;
      case 'item': {
        const indent = 8 + b.depth * 18;
        const itemTag = new Gtk.TextTag({ leftMargin: indent + 16, indent: -16 });
        buffer.get_tag_table().add(itemTag);
        insertMarkup(buffer, `<span foreground="#9a9996">${b.bullet}</span>  ${b.markup}`);
        tagFrom(buffer, itemTag, start);
        // espacement réduit entre éléments d'une même liste
        tagFrom(buffer, blocks[i + 1]?.kind === 'item' ? t.item : t.para, start);
        break;
      }
      case 'quote':
        insertMarkup(buffer, b.markup);
        tagFrom(buffer, t.quote, start);
        break;
      case 'code': {
        buffer.insert(buffer.get_end_iter(), b.text, -1);
        tagFrom(buffer, t.code, start);
        const lastLine = buffer.get_end_iter();
        lastLine.set_line_offset(0);
        buffer.apply_tag(t.codeEnd, lastLine, buffer.get_end_iter());
        break;
      }
      case 'table': {
        const anchor = buffer.create_child_anchor(buffer.get_end_iter());
        const table = Table({ header: b.header, rows: b.rows });
        if (table instanceof Gtk.Widget) {
          view.add_child_at_anchor(table, anchor);
          tables.push(table);
        }
        break;
      }
      case 'rule':
        buffer.insert(buffer.get_end_iter(), '⁂', -1);
        tagFrom(buffer, t.rule, start);
        break;
      default:
        assertNever(b);
    }
    if (!last) {
      buffer.insert(buffer.get_end_iter(), '\n', -1);
    }
  });
  // GtkTextView calcule sa hauteur pour une largeur donnée de manière asynchrone : quand il est
  // construit hors écran (largeur 0), sa première hauteur peut rester figée sur une seule ligne.
  // À chaque changement de largeur, on relance le calcul et on cale les tableaux ancrés.
  // Tableaux : GtkTextView alloue les widgets ancrés à leur largeur minimale, on la cale donc sur
  // la largeur de la vue. Pour ne pas bloquer le rétrécissement, quand la zone de défilement
  // (largeur de la fenêtre) change, les tableaux sont d'abord réduits, puis recalés.
  let width = -1;
  let outer = -1;
  let shrinking = false;
  view.add_tick_callback(() => {
    if (tables.length > 0) {
      const sw = view.get_ancestor(Gtk.ScrolledWindow.$gtype)?.get_width() ?? 0;
      if (sw !== outer) {
        outer = sw;
        shrinking = true;
        for (const table of tables) table.widthRequest = 100;
        view.queue_resize();
        return true;
      }
    }
    const w = view.get_width();
    if ((w !== width || shrinking) && w > 0) {
      width = w;
      shrinking = false;
      for (const table of tables) table.widthRequest = Math.max(100, w - 4);
      view.queue_resize();
    }
    return true;
  });
  return view;
}
