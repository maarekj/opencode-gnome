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

function Table({ header, rows }: { header: string[]; rows: string[][] }): JSX.Element {
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
