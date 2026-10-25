// Onglet « Issues » de la fenêtre git : issues GitHub du dépôt (via gh). Liste à gauche
// (filtre, recherche), détail à droite : description et commentaires en markdown.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createRoot } from 'gnim';
import { errorMessage } from '../shared/errors.ts';
import { esc, fmtFullDate, fmtRelative } from '../shared/format.ts';
import { issueDetail, listIssues, type IssueDetail, type IssueState, type IssueSummary } from '../shared/github.ts';
import { intercepted } from '../shared/sandbox.ts';
import { MarkdownView } from './Markdown.tsx';

const ms = (iso: string): number => Date.parse(iso);

/** Pastille d'étiquette à la couleur GitHub (texte clair ou foncé selon le fond). */
function labelMarkup(name: string, color = '888888'): string {
  const c = /^[0-9a-f]{6}$/iu.test(color) ? color : '888888';
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(c.slice(i, i + 2), 16));
  const light = 0.299 * (r ?? 0) + 0.587 * (g ?? 0) + 0.114 * (b ?? 0) > 150;
  return `<span background="#${c}" foreground="${light ? '#000000' : '#ffffff'}"> ${esc(name)} </span>`;
}

const stateIcon = (state: string, reason?: string | null): { icon: string; css: string; label: string } =>
  state === 'OPEN'
    ? { icon: 'radio-symbolic', css: 'success', label: 'Ouverte' }
    : reason === 'NOT_PLANNED'
      ? { icon: 'action-unavailable-symbolic', css: 'dim-label', label: 'Fermée (non prévue)' }
      : { icon: 'object-select-symbolic', css: 'accent', label: 'Fermée' };

function issueRow(i: IssueSummary): Gtk.ListBoxRow {
  const st = stateIcon(i.state);
  const row = new Gtk.ListBoxRow({ name: String(i.number), tooltipText: i.title });
  const box = new Gtk.Box({ spacing: 10, marginTop: 6, marginBottom: 6, marginStart: 6, marginEnd: 6 });
  box.append(new Gtk.Image({ iconName: st.icon, cssClasses: [st.css], valign: Gtk.Align.START, marginTop: 2, tooltipText: st.label }));
  const texts = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true });
  texts.append(new Gtk.Label({ label: i.title, xalign: 0, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, lines: 2, ellipsize: Pango.EllipsizeMode.END }));
  const meta = [`#${i.number}`, i.author?.login ?? '', fmtRelative(ms(i.updatedAt))].filter((x) => x !== '').join(' · ');
  texts.append(new Gtk.Label({ label: meta, xalign: 0, cssClasses: ['dim-label', 'caption'] }));
  if (i.labels.length > 0) {
    const labels = new Gtk.Label({ useMarkup: true, xalign: 0, wrap: true, cssClasses: ['caption'] });
    labels.set_markup(i.labels.map((l) => labelMarkup(l.name, l.color)).join(' '));
    texts.append(labels);
  }
  box.append(texts);
  if (i.comments.length > 0) {
    const c = new Gtk.Box({ spacing: 3, valign: Gtk.Align.START, cssClasses: ['dim-label'], tooltipText: `${i.comments.length} commentaire${i.comments.length > 1 ? 's' : ''}` });
    c.append(new Gtk.Image({ iconName: 'chat-message-new-symbolic', pixelSize: 12 }));
    c.append(new Gtk.Label({ label: String(i.comments.length), cssClasses: ['caption', 'numeric'] }));
    box.append(c);
  }
  row.child = box;
  return row;
}

/** Bloc de texte markdown (description ou commentaire) avec son en-tête. */
function post(author: string, date: string, body: string, dispose: Set<() => void>): Gtk.Widget {
  const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, cssClasses: ['card', 'issue-post'] });
  const head = new Gtk.Label({ xalign: 0, useMarkup: true, cssClasses: ['caption'], tooltipText: fmtFullDate(ms(date)) });
  head.set_markup(`<b>${esc(author)}</b>  <span alpha="60%">${esc(fmtRelative(ms(date)))}</span>`);
  card.append(head);
  const text = body.trim() === '' ? '*Aucune description.*' : body;
  // MarkdownView s'abonne aux préférences d'affichage : racine libérée au changement d'issue
  card.append(
    createRoot((d) => {
      dispose.add(d);
      return MarkdownView({ text });
    }),
  );
  return card;
}

function openUrl(from: Gtk.Widget, url: string): void {
  if (intercepted('LIEN', url)) return;
  const root = from.get_root();
  new Gtk.UriLauncher({ uri: url }).launch(root instanceof Gtk.Window ? root : null, null, null);
}

export function issuesTab(directory: string): { widget: Gtk.Widget; load: () => Promise<void> } {
  // ---- liste (gauche)
  const list = new Gtk.ListBox({ cssClasses: ['navigation-sidebar'] });
  const filter = new Adw.ToggleGroup({ cssClasses: ['round'], halign: Gtk.Align.CENTER, marginTop: 6 });
  for (const [name, label] of [
    ['open', 'Ouvertes'],
    ['closed', 'Fermées'],
    ['all', 'Toutes'],
  ] as const)
    filter.add(new Adw.Toggle({ name, label }));
  filter.activeName = 'open';
  const search = new Gtk.SearchEntry({ placeholderText: 'Rechercher (texte, label:bug, author:…)', marginStart: 8, marginEnd: 8, marginTop: 6, marginBottom: 6 });
  const count = new Gtk.Label({ xalign: 0, cssClasses: ['dim-label', 'caption'], marginStart: 12, marginBottom: 4 });
  const leftStack = new Gtk.Stack({ vexpand: true });
  leftStack.add_named(new Adw.Spinner({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, widthRequest: 32, heightRequest: 32 }), 'loading');
  leftStack.add_named(new Gtk.ScrolledWindow({ child: list, hscrollbarPolicy: Gtk.PolicyType.NEVER }), 'list');
  const empty = new Adw.StatusPage({ iconName: 'object-select-symbolic', title: 'Aucune issue', cssClasses: ['compact'] });
  leftStack.add_named(empty, 'empty');
  const error = new Adw.StatusPage({ iconName: 'dialog-error-symbolic', title: 'Issues indisponibles', cssClasses: ['compact'] });
  leftStack.add_named(error, 'error');
  const left = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, widthRequest: 300 });
  for (const w of [filter, search, count, new Gtk.Separator(), leftStack]) left.append(w);

  // ---- détail (droite)
  const title = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, cssClasses: ['title-3'] });
  const meta = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, useMarkup: true, cssClasses: ['caption'] });
  const openBtn = new Gtk.Button({ iconName: 'web-browser-symbolic', tooltipText: 'Ouvrir sur GitHub', cssClasses: ['flat'], valign: Gtk.Align.START });
  const head = new Gtk.Box({ spacing: 6 });
  const headTexts = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, hexpand: true });
  headTexts.append(title);
  headTexts.append(meta);
  head.append(headTexts);
  head.append(openBtn);
  const posts = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 });
  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 16, marginTop: 16, marginBottom: 24, marginStart: 20, marginEnd: 20 });
  content.append(head);
  content.append(posts);
  const detail = new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, child: new Adw.Clamp({ maximumSize: 900, child: content }) });
  const rightStack = new Gtk.Stack({ transitionType: Gtk.StackTransitionType.CROSSFADE, hexpand: true });
  rightStack.add_named(new Adw.StatusPage({ iconName: 'mail-unread-symbolic', title: 'Choisis une issue', cssClasses: ['compact'] }), 'none');
  rightStack.add_named(new Adw.Spinner({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, widthRequest: 32, heightRequest: 32 }), 'loading');
  rightStack.add_named(detail, 'issue');
  const rightError = new Adw.StatusPage({ iconName: 'dialog-error-symbolic', title: 'Issue illisible', cssClasses: ['compact'] });
  rightStack.add_named(rightError, 'error');

  let url = '';
  openBtn.connect('clicked', () => {
    if (url !== '') openUrl(openBtn, url);
  });

  const disposers = new Set<() => void>();
  const clearPosts = (): void => {
    for (const d of disposers) d();
    disposers.clear();
    for (let c = posts.get_first_child(); c !== null; c = posts.get_first_child()) posts.remove(c);
  };

  const show = (d: IssueDetail): void => {
    const st = stateIcon(d.state, d.stateReason);
    url = d.url;
    title.label = `${d.title}  #${d.number}`;
    const parts = [
      `<b>${esc(st.label)}</b>`,
      `ouverte par <b>${esc(d.author?.login ?? '?')}</b> ${esc(fmtRelative(ms(d.createdAt)))}`,
      d.closedAt === null || d.closedAt === undefined ? '' : `fermée ${esc(fmtRelative(ms(d.closedAt)))}`,
      d.assignees.length === 0 ? '' : `assignée à ${d.assignees.map((a) => `<b>${esc(a.login)}</b>`).join(', ')}`,
      `${d.comments.length} commentaire${d.comments.length > 1 ? 's' : ''}`,
    ].filter((x) => x !== '');
    meta.set_markup(`${parts.join('  ·  ')}${d.labels.length === 0 ? '' : `\n${d.labels.map((l) => labelMarkup(l.name, l.color)).join(' ')}`}`);
    clearPosts();
    posts.append(post(d.author?.login ?? '?', d.createdAt, d.body, disposers));
    for (const c of d.comments) posts.append(post(c.author?.login ?? '?', c.createdAt, c.body, disposers));
    detail.get_vadjustment().set_value(0);
    rightStack.visibleChildName = 'issue';
  };

  let detailSeq = 0;
  let selected: number | null = null;
  list.connect('row-selected', (_l: Gtk.ListBox, row: Gtk.ListBoxRow | null) => {
    if (row === null) return;
    const n = Number(row.name);
    if (n === selected && rightStack.visibleChildName === 'issue') return;
    selected = n;
    const seq = (detailSeq += 1);
    rightStack.visibleChildName = 'loading';
    issueDetail(directory, n).then(
      (d) => {
        if (seq === detailSeq) show(d);
        return null;
      },
      (e: unknown) => {
        if (seq !== detailSeq) return null;
        rightError.description = esc(errorMessage(e));
        rightStack.visibleChildName = 'error';
        return null;
      },
    );
  });

  let listSeq = 0;
  /** dernière liste de chaque filtre : affichée tout de suite, puis rafraîchie */
  const cache = new Map<string, IssueSummary[]>();
  const fill = (issues: readonly IssueSummary[]): void => {
    for (let r = list.get_row_at_index(0); r !== null; r = list.get_row_at_index(0)) list.remove(r);
    for (const i of issues) list.append(issueRow(i));
    count.label = `${issues.length} issue${issues.length > 1 ? 's' : ''}${issues.length >= 200 ? ' (200 premières)' : ''}`;
    empty.description = search.text.trim() === '' ? '' : 'Aucune issue ne correspond à la recherche.';
    leftStack.visibleChildName = issues.length === 0 ? 'empty' : 'list';
    // l'issue affichée reste sélectionnée si elle est encore listée
    const keep = selected === null ? -1 : issues.findIndex((i) => i.number === selected);
    if (keep >= 0) list.select_row(list.get_row_at_index(keep));
  };
  const load = async (): Promise<void> => {
    const seq = (listSeq += 1);
    const name = filter.activeName;
    const state: IssueState = name === 'closed' || name === 'all' ? name : 'open';
    const key = `${state}|${search.text.trim()}`;
    const cached = cache.get(key);
    // gh met quelques secondes : liste du filtre en cache, sinon indicateur de chargement
    if (cached === undefined) {
      leftStack.visibleChildName = 'loading';
      count.label = 'Chargement…';
    } else fill(cached);
    try {
      const issues = await listIssues(directory, state, search.text);
      cache.set(key, issues);
      if (seq !== listSeq) return;
      fill(issues);
    } catch (e) {
      if (seq !== listSeq) return;
      error.description = esc(errorMessage(e));
      leftStack.visibleChildName = 'error';
    }
  };
  filter.connect('notify::active-name', () => void load());
  // recherche : après une pause de frappe (search-changed est déjà temporisé par GTK)
  search.connect('search-changed', () => void load());

  const paned = new Gtk.Paned({ startChild: left, endChild: rightStack, position: 400, shrinkStartChild: false, shrinkEndChild: false });
  return { widget: paned, load };
}

