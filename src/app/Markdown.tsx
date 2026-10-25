// Markdown -> Gtk widgets (blocks from src/shared/markdown.ts).
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import type GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import { createState, onCleanup } from 'gnim';
import { parseMarkdown, stripMarkup, type Block } from '../shared/markdown.ts';
import { DEFAULT_MARKDOWN_STYLE, type MarkdownStyle } from '../shared/settings.ts';
import { intercepted } from '../shared/sandbox.ts';

// ---------------------------------------------------------------- style (préférences)

/** Style courant du rendu ; les vues markdown se reconstruisent quand il change. */
const [markdownStyle, setStyle] = createState<MarkdownStyle>(DEFAULT_MARKDOWN_STYLE, {
  equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
});
export { markdownStyle };
/** Incrémenté quand le thème ou l'accent change (couleurs recalculées). */
const [themeRev, setThemeRev] = createState(0);
export function refreshMarkdownColors(): void {
  setThemeRev(themeRev.peek() + 1);
}

let pendingStyle: MarkdownStyle | null = null;
/** Change le style (regroupé : un curseur qu'on fait glisser n'entraîne qu'une reconstruction). */
export function setMarkdownStyle(style: MarkdownStyle): void {
  if (pendingStyle === null) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
      if (pendingStyle !== null) setStyle(pendingStyle);
      pendingStyle = null;
      return GLib.SOURCE_REMOVE;
    });
  }
  pendingStyle = style;
}

interface Palette {
  readonly heading: string | null;
  readonly bullet: string;
  readonly code: string | null;
  readonly codeBackground: string;
  readonly quote: string;
  readonly quoteBar: string | null;
}

/** Couleurs selon le réglage et le thème (clair / sombre), accent de GNOME pour les titres. */
function palette(colors: MarkdownStyle['colors']): Palette {
  const sm = Adw.StyleManager.get_default();
  const dark = sm.dark;
  let accent: string;
  try {
    // Pango n'accepte pas « rgb(…) » : couleur en hexadécimal
    const c = sm.get_accent_color_rgba();
    accent = `#${[c.red, c.green, c.blue].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
  } catch {
    accent = dark ? '#78aeed' : '#1c71d8';
  }
  const neutral: Palette = { heading: null, bullet: '#9a9996', code: null, codeBackground: '#8080801a', quote: '#77767b', quoteBar: null };
  if (colors === 'sober') return neutral;
  if (colors === 'headings') return { ...neutral, heading: accent };
  return {
    heading: accent,
    bullet: accent,
    code: dark ? '#dc8add' : '#9141ac',
    codeBackground: dark ? '#dc8add1f' : '#9141ac14',
    quote: dark ? '#9a9996' : '#5e5c64',
    quoteBar: accent,
  };
}

/** Police à chasse fixe de GNOME (« monospace » seul peut retomber sur une autre police). */
let mono = 'monospace';
export function setMonospaceFamily(family: string): void {
  mono = family;
}
const familyOf = (font: MarkdownStyle['font']): string | null => (font === 'mono' ? mono : font === 'serif' ? 'serif' : null);

/**
 * Markup Pango valide ? `set_markup` / `insert_markup` ne lèvent pas d'erreur sur un markup
 * invalide (simple g_warning, rien d'affiché) : il faut le valider avant (#56). Les `<a>`
 * (propres à GtkLabel) sont vérifiés comme des `<span>`.
 */
export function validMarkup(markup: string): boolean {
  try {
    Pango.parse_markup(markup.replaceAll(/<a href="[^"]*">/gu, '<span>').replaceAll('</a>', '</span>'), -1, '');
    return true;
  } catch {
    return false;
  }
}

/** Sets Pango markup, falling back to plain text if the markup is invalid. */
function setMarkup(label: Gtk.Label, markup: string): void {
  if (validMarkup(markup)) label.set_markup(markup);
  else label.set_text(stripMarkup(markup));
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

const COLUMN_SPACING = 18;
const TABLE_PADDING = 24; // .md-table : 12 px à gauche et à droite

/** Longueur visible d'une cellule (markup retiré), pour répartir les colonnes. */
const visibleLength = (markup: string): number => markup.replaceAll(/<[^>]+>/gu, '').replaceAll(/&[a-z#0-9]+;/gu, 'x').length;

/** Mots d'une cellule (markup retiré, entités décodées). */
const wordsOf = (markup: string): string[] =>
  markup
    .replaceAll(/<[^>]+>/gu, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .split(/\s+/u)
    .filter((w) => w !== '');

interface ColumnSizes {
  /** plus long mot de chaque colonne (une colonne ne coupe pas ses mots, jusqu'à 20 caractères) */
  readonly longest: string[];
  /** poids pour répartir le reste (longueur du contenu, plafonnée) */
  readonly weights: number[];
}

function columnSizes(rows: readonly (readonly string[])[], columns: number): ColumnSizes {
  const col = (x: number): string[] => rows.map((r) => r[x] ?? '');
  const longest = Array.from({ length: columns }, (_v, x) =>
    col(x)
      .flatMap((c) => wordsOf(c))
      .map((w) => w.slice(0, 20))
      .reduce((a, w) => (w.length > a.length ? w : a), ''),
  );
  const lengths = Array.from({ length: columns }, (_v, x) => Math.min(60, Math.max(2, ...col(x).map((c) => visibleLength(c)))));
  const total = lengths.reduce((a, b) => a + b, 0);
  return { longest, weights: lengths.map((l) => l / total) };
}

/** Cellules de chaque tableau, par colonne (pour fixer leur largeur). */
const tableColumns = new WeakMap<Gtk.Widget, { sizes: ColumnSizes; cells: Gtk.Label[][]; mins?: number[] }>();

/** Fixe la largeur totale d'un tableau : chaque colonne reçoit sa part. */
export function setTableWidth(table: Gtk.Widget, width: number): void {
  table.widthRequest = width;
  const info = tableColumns.get(table);
  if (info === undefined) return;
  const { longest, weights } = info.sizes;
  const free = Math.max(0, width - TABLE_PADDING - COLUMN_SPACING * (weights.length - 1));
  // chaque colonne a au moins la largeur de son plus long mot ; le reste est réparti selon le contenu
  // mesuré une fois avec la police réelle (en gras : l'en-tête l'est)
  info.mins ??= longest.map((word) => {
    const layout = table.create_pango_layout(null);
    layout.set_markup(`<b>${GLib.markup_escape_text(word, -1)}</b>`, -1);
    return layout.get_pixel_size()[0] + 2;
  });
  const mins = info.mins;
  const minTotal = mins.reduce((a, b) => a + b, 0);
  const widths =
    minTotal >= free
      ? mins.map((m) => Math.floor((m / Math.max(1, minTotal)) * free))
      : (() => {
          // poids appliqués au total, sans descendre sous le minimum
          const target = weights.map((w) => w * free);
          const fixed = target.map((t, x) => t < (mins[x] ?? 0));
          const rest = free - mins.reduce((a, m, x) => a + (fixed[x] === true ? m : 0), 0);
          const restWeight = weights.reduce((a, w, x) => a + (fixed[x] === true ? 0 : w), 0) || 1;
          return weights.map((w, x) => (fixed[x] === true ? (mins[x] ?? 0) : Math.floor((w / restWeight) * rest)));
        })();
  widths.forEach((w, x) => {
    for (const cell of info.cells[x] ?? []) cell.widthRequest = Math.max(10, w);
  });
}

export function Table({ header, rows }: { header: string[]; rows: string[][] }): Gtk.Widget {
  // Lignes en Gtk.Box horizontales ; la largeur de chaque colonne est fixée par setTableWidth,
  // proportionnellement à son contenu. Ni Gtk.Grid ni ScrolledWindow : ils calculent mal la
  // hauteur des labels repliés.
  const all = [header, ...rows];
  const columns = Math.max(...all.map((r) => r.length));
  const cells: Gtk.Label[][] = Array.from({ length: columns }, () => []);
  const table = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, cssClasses: ['card', 'md-table'] });
  all.forEach((row, y) => {
    const line = new Gtk.Box({ spacing: COLUMN_SPACING });
    for (let x = 0; x < columns; x += 1) {
      const label = new Gtk.Label({ wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, xalign: 0, valign: Gtk.Align.START, selectable: true });
      // liens des cellules : même ouverture que ceux du texte (journalisés en test : #96)
      label.connect('activate-link', (_l: Gtk.Label, uri: string) => {
        openLink(label, uri);
        return true;
      });
      const cell = row[x] ?? '';
      setMarkup(label, y === 0 ? `<b>${cell}</b>` : cell);
      cells[x]?.push(label);
      line.append(label);
    }
    table.append(line);
  });
  tableColumns.set(table, { sizes: columnSizes(all, columns), cells });
  return table;
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
const ttAsSpan = (markup: string, p: Palette): string =>
  markup
    // <tt> n'est pas appliqué par GtkTextBuffer : police monospace explicite
.replaceAll('<tt>', `<span font_family="${mono}" background="${p.codeBackground}"${p.code === null ? '' : ` foreground="${p.code}"`}>`)
    .replaceAll('</tt>', '</span>');


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
    openLink(view, url);
  });
  view.add_controller(click);
}

/** Liens « ouverts » en bac à sable (captures et tests). */
export const testLinks: string[] = [];

/** Ouvre un lien ; en test, il est journalisé au lieu d'ouvrir le navigateur. */
function openLink(from: Gtk.Widget, url: string): void {
  if (intercepted('LIEN', url)) {
    testLinks.push(url);
    return;
  }
  const root = from.get_root();
  new Gtk.UriLauncher({ uri: url }).launch(root instanceof Gtk.Window ? root : null, null, null);
}

function tags(buffer: Gtk.TextBuffer, st: MarkdownStyle, p: Palette): Record<'para' | 'h1' | 'h2' | 'h3' | 'item' | 'quote' | 'code' | 'codeEnd' | 'rule', Gtk.TextTag> {
  const gap = Math.max(0, st.paragraphSpacing);
  const color = p.heading === null ? {} : { foreground: p.heading };
  const table = buffer.get_tag_table();
  const tag = (name: string, props: Partial<Gtk.TextTag.ConstructorProps>): Gtk.TextTag => {
    const t = new Gtk.TextTag({ name, ...props });
    table.add(t);
    return t;
  };
  return {
    para: tag('para', { pixelsBelowLines: gap }),
    h1: tag('h1', { scale: 1.45, weight: Pango.Weight.BOLD, pixelsAboveLines: Math.round(gap * 0.75), pixelsBelowLines: gap, ...color }),
    h2: tag('h2', { scale: 1.25, weight: Pango.Weight.BOLD, pixelsAboveLines: Math.round(gap * 0.75), pixelsBelowLines: gap, ...color }),
    h3: tag('h3', { weight: Pango.Weight.BOLD, pixelsAboveLines: Math.round(gap / 2), pixelsBelowLines: Math.round(gap * 0.75), ...color }),
    item: tag('item', { pixelsBelowLines: Math.round(gap / 2) }),
    quote: tag('quote', {
      style: Pango.Style.ITALIC,
      leftMargin: 14,
      foreground: p.quote,
      pixelsBelowLines: gap,
      ...(p.quoteBar === null ? {} : { paragraphBackground: `${p.quoteBar}14` }),
    }),
    code: tag('code', { family: mono, paragraphBackground: 'rgba(127,127,127,0.10)', leftMargin: 10, rightMargin: 10, pixelsBelowLines: 0 }),
    // créé après `code` : prioritaire, espace sous la dernière ligne d'un bloc de code
    codeEnd: tag('codeEnd', { pixelsBelowLines: Math.round(gap * 1.25) }),
    rule: tag('rule', { foreground: '#9a9996', pixelsBelowLines: gap, justification: Gtk.Justification.CENTER }),
  };
}

/** Repères de début / fin de lien, insérés dans le texte puis retirés (cf. insertMarkup). */
const LINK_START = '\uE010';
const LINK_END = '\uE011';

/**
 * Insère du markup Pango (texte brut si invalide). Les <a> ne sont pas gérés par GtkTextBuffer :
 * remplacés par des repères (le markup reste d'un seul tenant, `**voir [doc](u)**` compris),
 * puis chaque lien devient un TextTag associé à son URL.
 */
function insertMarkup(buffer: Gtk.TextBuffer, markup: string, p: Palette): void {
  if (markup === '') return;
  const urls: string[] = [];
  const marked = ttAsSpan(markup, p)
    .replaceAll(/<a href="([^"]*)">/gu, (_m, url: string) => {
      urls.push(unescapeUrl(url));
      return LINK_START;
    })
    .replaceAll('</a>', LINK_END);
  const start = buffer.get_char_count();
  if (validMarkup(marked)) buffer.insert_markup(buffer.get_end_iter(), marked, -1);
  else buffer.insert(buffer.get_end_iter(), stripMarkup(marked), -1);
  if (urls.length === 0) return;
  // repères -> TextTag de lien
  let from = buffer.get_iter_at_offset(start);
  for (const url of urls) {
    const [opened, openStart, openEnd] = from.forward_search(LINK_START, Gtk.TextSearchFlags.TEXT_ONLY, null);
    if (!opened || openStart === null || openEnd === null) break;
    const linkStart = openStart.get_offset();
    buffer.delete(openStart, openEnd);
    const [closed, closeStart, closeEnd] = buffer.get_iter_at_offset(linkStart).forward_search(LINK_END, Gtk.TextSearchFlags.TEXT_ONLY, null);
    if (!closed || closeStart === null || closeEnd === null) break;
    const linkEnd = closeStart.get_offset();
    buffer.delete(closeStart, closeEnd);
    const tag = new Gtk.TextTag({ underline: Pango.Underline.SINGLE, foreground: '#3584e4' });
    buffer.get_tag_table().add(tag);
    linkUrls.set(tag, url);
    buffer.apply_tag(tag, buffer.get_iter_at_offset(linkStart), buffer.get_iter_at_offset(linkEnd));
    from = buffer.get_iter_at_offset(linkEnd);
  }
}

/** Applique `tag` à tout ce qui a été inséré depuis `offset`. */
const tagFrom = (buffer: Gtk.TextBuffer, tag: Gtk.TextTag, offset: number): void => {
  buffer.apply_tag(tag, buffer.get_iter_at_offset(offset), buffer.get_end_iter());
};

/**
 * Force GtkTextView à recalculer toute sa mise en page : un simple queue_resize ne suffit pas
 * quand la taille d'un widget ancré change (hauteur restée figée, texte non redessiné).
 */
function relayout(view: Gtk.TextView): void {
  const mode = view.wrapMode;
  view.wrapMode = mode === Gtk.WrapMode.NONE ? Gtk.WrapMode.CHAR : Gtk.WrapMode.NONE;
  view.wrapMode = mode;
  view.queue_resize();
}

/**
 * Markdown rendu dans des Gtk.TextView non éditables : la sélection s'étend librement sur
 * les paragraphes, titres, listes et code. Les tableaux sont des widgets entre deux zones de texte.
 */
export function MarkdownView({ text }: { text: string }): Gtk.Widget {
  const holder = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
  let child: Gtk.Widget | null = null;
  const build = (): void => {
    if (child !== null) holder.remove(child);
    child = renderMarkdown(text, markdownStyle.peek());
    holder.append(child);
  };
  build();
  // préférences d'apparence changées : reconstruit
  onCleanup(markdownStyle.subscribe(build));
  onCleanup(themeRev.subscribe(build));
  return holder;
}

function renderMarkdown(text: string, st: MarkdownStyle): Gtk.Widget {
  const p = palette(st.colors);
  const family = familyOf(st.font);
  const blocks = parseMarkdown(text);
  // un message sans tableau : un seul TextView (sélection libre sur tout le message)
  const segments = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
  let current: { view: Gtk.TextView; buffer: Gtk.TextBuffer; t: ReturnType<typeof tags> } | null = null;
  const textView = (): NonNullable<typeof current> => {
    if (current !== null) return current;
    const buffer = new Gtk.TextBuffer();
    const view = new Gtk.TextView({
      buffer,
      editable: false,
      cursorVisible: false,
      wrapMode: Gtk.WrapMode.WORD_CHAR,
      cssClasses: ['markdown-view'],
      hexpand: true,
      pixelsInsideWrap: Math.max(0, st.lineSpacing),
    });
    enableLinks(view);
    fixHeight(view);
    segments.append(view);
    const t = tags(buffer, st, p);
    // police de tout le texte (le code reste à chasse fixe : son étiquette est prioritaire)
    if (family !== null) {
      const base = new Gtk.TextTag({ family });
      buffer.get_tag_table().add(base);
      baseTags.set(buffer, base);
    }
    current = { view, buffer, t };
    return current;
  };

  blocks.forEach((b, i) => {
    // les tableaux sont des widgets à part, entre deux zones de texte
    if (b.kind === 'table') {
      const table = Table({ header: b.header, rows: b.rows });
      if (family !== null) table.add_css_class(`md-font-${st.font}`);
      table.marginTop = 4;
      table.marginBottom = 14;
      segments.append(table);
      fitTable(table);
      current = null;
      return;
    }
    const { buffer, t } = textView();
    // séparateur avec le bloc précédent de la même zone de texte
    if (buffer.get_char_count() > 0) buffer.insert(buffer.get_end_iter(), '\n', -1);
    const start = buffer.get_char_count();
    switch (b.kind) {
      case 'paragraph':
        insertMarkup(buffer, b.markup, p);
        tagFrom(buffer, t.para, start);
        break;
      case 'heading':
        insertMarkup(buffer, b.markup, p);
        tagFrom(buffer, b.level === 1 ? t.h1 : b.level === 2 ? t.h2 : t.h3, start);
        break;
      case 'item': {
        const indent = 8 + b.depth * 18;
        const itemTag = new Gtk.TextTag({ leftMargin: indent + 16, indent: -16 });
        buffer.get_tag_table().add(itemTag);
        insertMarkup(buffer, `<span foreground="${p.bullet}">${b.bullet}</span>  ${b.markup}`, p);
        tagFrom(buffer, itemTag, start);
        // espacement réduit entre éléments d'une même liste
        tagFrom(buffer, blocks[i + 1]?.kind === 'item' ? t.item : t.para, start);
        break;
      }
      case 'quote':
        insertMarkup(buffer, (p.quoteBar === null ? '' : `<span foreground="${p.quoteBar}">▍</span> `) + b.markup, p);
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
      case 'rule':
        buffer.insert(buffer.get_end_iter(), '⁂', -1);
        tagFrom(buffer, t.rule, start);
        break;
      default:
        assertNever(b);
    }
  });
  // police choisie : appliquée à tout le texte de chaque zone (sous les autres étiquettes)
  for (let w = segments.get_first_child(); w !== null; w = w.get_next_sibling()) {
    if (!(w instanceof Gtk.TextView)) continue;
    const base = baseTags.get(w.buffer);
    if (base !== undefined) {
      base.set_priority(0);
      w.buffer.apply_tag(base, w.buffer.get_start_iter(), w.buffer.get_end_iter());
    }
  }
  return segments;
}

/** Étiquette de police de chaque zone de texte. */
const baseTags = new WeakMap<Gtk.TextBuffer, Gtk.TextTag>();

/**
 * Appelle `check` à chaque image tant qu'il agit, puis s'arrête (3 images sans changement).
 * Relancé à l'affichage et quand la largeur disponible change (zone de défilement, fenêtre).
 * Pas de tick callback permanent : il ferait tourner l'horloge d'images en continu (#57).
 */
function watchWidth(widget: Gtk.Widget, check: () => boolean): void {
  let ticking = false;
  const kick = (): void => {
    if (ticking) return;
    ticking = true;
    let still = 0;
    widget.add_tick_callback(() => {
      still = check() ? 0 : still + 1;
      if (still < 3) return true;
      ticking = false;
      return false;
    });
  };
  const handlers: [GObject.Object, number][] = [];
  widget.connect('map', () => {
    kick();
    const sw = widget.get_ancestor(Gtk.ScrolledWindow.$gtype);
    if (sw instanceof Gtk.ScrolledWindow) {
      const adj = sw.get_hadjustment();
      handlers.push([adj, adj.connect('changed', kick)]);
    }
    const root = widget.get_root();
    if (root instanceof Gtk.Window) handlers.push([root, root.connect('notify::default-width', kick)]);
  });
  widget.connect('unmap', () => {
    for (const [o, id] of handlers.splice(0)) o.disconnect(id);
  });
}

/**
 * GtkTextView calcule sa hauteur pour une largeur donnée de manière asynchrone : construit hors
 * écran (largeur 0), sa première hauteur peut rester figée sur une ligne. À chaque changement
 * de largeur, on relance le calcul.
 */
function fixHeight(view: Gtk.TextView): void {
  let width = -1;
  watchWidth(view, () => {
    const w = view.get_width();
    if (w === width || w <= 0) return false;
    width = w;
    relayout(view);
    return true;
  });
}

/**
 * Largeur d'un tableau calée sur la place disponible (celle de son parent). Pour ne pas bloquer
 * le rétrécissement de la fenêtre, quand la zone de défilement change de largeur, le tableau
 * est d'abord réduit, puis recalé sur la nouvelle largeur du parent.
 */
function fitTable(table: Gtk.Widget): void {
  let outer = -1;
  let width = -1;
  let shrinking = false;
  watchWidth(table, () => {
    const parent = table.get_parent();
    const sw = table.get_ancestor(Gtk.ScrolledWindow.$gtype)?.get_width() ?? 0;
    if (sw !== outer) {
      outer = sw;
      shrinking = true;
      setTableWidth(table, 100);
      return true;
    }
    const w = parent?.get_width() ?? 0;
    if ((w === width && !shrinking) || w <= 0) return false;
    width = w;
    shrinking = false;
    setTableWidth(table, w);
    return true;
  });
}
