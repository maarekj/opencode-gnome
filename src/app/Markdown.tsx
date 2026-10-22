// Markdown -> Gtk widgets (blocks from src/shared/markdown.ts).
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
const linksAsText = (markup: string): string =>
  markup
    .replaceAll(/<a href="[^"]*">/gu, '<span underline="single" foreground="#3584e4">')
    .replaceAll('</a>', '</span>')
    // <tt> n'est pas appliqué par GtkTextBuffer : police monospace explicite
    .replaceAll('<tt>', '<span font_family="monospace" background="#8080801a">')
    .replaceAll('</tt>', '</span>');

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
function insertMarkup(buffer: Gtk.TextBuffer, markup: string, plain: string): void {
  try {
    buffer.insert_markup(buffer.get_end_iter(), linksAsText(markup), -1);
  } catch {
    buffer.insert(buffer.get_end_iter(), plain, -1);
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
  const tables: Gtk.Widget[] = [];
  const blocks = parseMarkdown(text);
  blocks.forEach((b, i) => {
    const start = buffer.get_char_count();
    const last = i === blocks.length - 1;
    switch (b.kind) {
      case 'paragraph':
        insertMarkup(buffer, b.markup, b.markup);
        tagFrom(buffer, t.para, start);
        break;
      case 'heading':
        insertMarkup(buffer, b.markup, b.markup);
        tagFrom(buffer, b.level === 1 ? t.h1 : b.level === 2 ? t.h2 : t.h3, start);
        break;
      case 'item': {
        const indent = 8 + b.depth * 18;
        const itemTag = new Gtk.TextTag({ leftMargin: indent + 16, indent: -16 });
        buffer.get_tag_table().add(itemTag);
        insertMarkup(buffer, `<span foreground="#9a9996">${b.bullet}</span>  ${b.markup}`, b.markup);
        tagFrom(buffer, itemTag, start);
        // espacement réduit entre éléments d'une même liste
        tagFrom(buffer, blocks[i + 1]?.kind === 'item' ? t.item : t.para, start);
        break;
      }
      case 'quote':
        insertMarkup(buffer, b.markup, b.markup);
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
  // les widgets ancrés prennent leur largeur naturelle : on les cale sur la largeur de la vue
  if (tables.length > 0) {
    let width = -1;
    view.add_tick_callback(() => {
      const w = view.get_width();
      if (w !== width && w > 0) {
        width = w;
        for (const table of tables) table.widthRequest = Math.max(100, w - 4);
      }
      return true;
    });
  }
  return view;
}
