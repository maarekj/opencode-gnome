// Recherche dans toutes les conversations (Ctrl+Maj+F) : texte des messages et titres des
// sessions, filtres projet et période ; résultats groupés par session, extrait mis en évidence.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { errorMessage } from '../shared/errors.ts';
import { esc, fmtRelative, fmtFullDate } from '../shared/format.ts';
import { matchRanges, terms, type SearchHit, type SearchIndex } from '../shared/search.ts';
import { prettyPath, type ProjectView } from '../shared/store.ts';

const DAY = 24 * 3600 * 1000;
const PERIODS: readonly { label: string; ms: number | null }[] = [
  { label: 'Toute période', ms: null },
  { label: '7 derniers jours', ms: 7 * DAY },
  { label: '30 derniers jours', ms: 30 * DAY },
  { label: '12 derniers mois', ms: 365 * DAY },
];
/** extraits affichés par session (les autres sont comptés) */
const PER_SESSION = 3;

/** Texte avec les termes en gras (markup Pango échappé). */
function highlighted(text: string, query: readonly string[]): string {
  let out = '';
  let at = 0;
  for (const [a, b] of matchRanges(text, query)) {
    if (a < at) continue;
    out += `${esc(text.slice(at, a))}<b>${esc(text.slice(a, b))}</b>`;
    at = b;
  }
  return out + esc(text.slice(at));
}

export interface SearchOptions {
  readonly index: SearchIndex;
  readonly projects: () => readonly ProjectView[];
  /** projet présélectionné (clé), null : tous */
  readonly project: string | null;
  /** ouvre la session, et le message s'il est donné */
  readonly open: (sessionID: string, messageID: string | null, partID: string | null) => void;
}

let current: Adw.Dialog | null = null;

export function openSearch(parent: Gtk.Widget, o: SearchOptions): void {
  if (current !== null) {
    current.present(parent);
    return;
  }
  const dialog = new Adw.Dialog({ title: 'Rechercher dans les conversations', contentWidth: 820, contentHeight: 680 });
  current = dialog;
  dialog.connect('closed', () => {
    current = null;
  });

  const entry = new Gtk.SearchEntry({ placeholderText: 'Rechercher dans toutes les conversations…', hexpand: true });
  const projects = [...o.projects()].toSorted((a, b) => a.name.localeCompare(b.name));
  const projectKeys = [null, ...projects.map((p) => p.key)];
  const projectDD = Gtk.DropDown.new_from_strings(['Tous les projets', ...projects.map((p) => (projects.filter((q) => q.name === p.name).length > 1 ? `${p.name} (${prettyPath(p.path)})` : p.name))]);
  projectDD.tooltipText = 'Projet';
  projectDD.selected = Math.max(0, projectKeys.indexOf(o.project));
  const periodDD = Gtk.DropDown.new_from_strings(PERIODS.map((p) => p.label));
  periodDD.tooltipText = 'Période';
  const filters = new Gtk.Box({ spacing: 6, marginStart: 12, marginEnd: 12, marginTop: 6, marginBottom: 6 });
  filters.append(entry);
  filters.append(projectDD);
  filters.append(periodDD);

  const status = new Gtk.Label({ xalign: 0, marginStart: 14, marginEnd: 14, marginBottom: 4, cssClasses: ['dim-label', 'caption'] });
  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.BROWSE, cssClasses: ['navigation-sidebar', 'search-results'] });
  const empty = new Adw.StatusPage({ iconName: 'system-search-symbolic', title: 'Rechercher dans les conversations', description: 'Messages et titres de toutes les sessions, de tous les projets.', vexpand: true, cssClasses: ['compact'] });
  const stack = new Gtk.Stack({ vexpand: true });
  stack.add_named(empty, 'empty');
  stack.add_named(new Gtk.ScrolledWindow({ child: list, hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true }), 'list');

  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  content.append(filters);
  content.append(status);
  content.append(stack);
  const view = new Adw.ToolbarView({ content });
  view.add_top_bar(new Adw.HeaderBar());
  dialog.child = view;

  /** résultat de chaque ligne activable */
  const targets = new Map<Gtk.ListBoxRow, SearchHit>();
  let indexing = '';

  const render = (): void => {
    for (let r = list.get_row_at_index(0); r !== null; r = list.get_row_at_index(0)) list.remove(r);
    targets.clear();
    const q = terms(entry.text);
    if (q.length === 0) {
      empty.title = 'Rechercher dans les conversations';
      empty.description = 'Messages et titres de toutes les sessions, de tous les projets.';
      stack.visibleChildName = 'empty';
      status.label = indexing;
      return;
    }
    const period = PERIODS[periodDD.selected]?.ms ?? null;
    const project = projectKeys[projectDD.selected] ?? null;
    let hits: SearchHit[];
    try {
      hits = o.index.search(entry.text, { ...(project === null ? {} : { project }), ...(period === null ? {} : { since: Date.now() - period }) });
    } catch (e) {
      // libgda absent, base illisible…
      empty.title = 'Recherche indisponible';
      empty.description = esc(errorMessage(e));
      stack.visibleChildName = 'empty';
      status.label = '';
      return;
    }
    // groupés par session, dans l'ordre de leur résultat le plus récent
    const groups = new Map<string, SearchHit[]>();
    for (const h of hits) groups.set(h.session.id, [...(groups.get(h.session.id) ?? []), h]);
    const names = new Map(o.projects().map((p) => [p.key, p.name]));
    for (const group of groups.values()) {
      const s = group[0]?.session;
      if (s === undefined) continue;
      const projectName = names.get(s.projectID) ?? names.get(`dir:${s.directory}`) ?? prettyPath(s.directory);
      const header = new Gtk.ListBoxRow({ activatable: true, selectable: true, cssClasses: ['search-session'] });
      const hbox = new Gtk.Box({ spacing: 8, marginTop: 10, marginStart: 6, marginEnd: 6 });
      hbox.append(new Gtk.Image({ iconName: 'chat-message-new-symbolic', cssClasses: ['dim-label'] }));
      hbox.append(new Gtk.Label({ label: s.title === '' ? 'Sans titre' : s.title, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['heading'] }));
      hbox.append(new Gtk.Label({ label: projectName, cssClasses: ['dim-label', 'caption'] }));
      header.child = hbox;
      header.tooltipText = `${projectName} — ${prettyPath(s.directory)}`;
      list.append(header);
      targets.set(header, { session: s, text: null, snippet: '' });
      const texts = group.filter((h) => h.text !== null);
      for (const h of texts.slice(0, PER_SESSION)) {
        const t = h.text;
        if (t === null) continue;
        const row = new Gtk.ListBoxRow({ activatable: true });
        const box = new Gtk.Box({ spacing: 8, marginStart: 30, marginEnd: 6, marginTop: 2, marginBottom: 2 });
        box.append(new Gtk.Image({ iconName: t.role === 'user' ? 'avatar-default-symbolic' : 'applications-science-symbolic', cssClasses: ['dim-label'], valign: Gtk.Align.START, tooltipText: t.role === 'user' ? 'Ton message' : 'Réponse de l’agent' }));
        box.append(new Gtk.Label({ label: highlighted(h.snippet, q), useMarkup: true, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, lines: 3, ellipsize: Pango.EllipsizeMode.END, xalign: 0, hexpand: true, maxWidthChars: 1 }));
        box.append(new Gtk.Label({ label: fmtRelative(t.created), tooltipText: fmtFullDate(t.created), valign: Gtk.Align.START, cssClasses: ['dim-label', 'caption'] }));
        row.child = box;
        list.append(row);
        targets.set(row, h);
      }
      if (texts.length > PER_SESSION) {
        const more = new Gtk.ListBoxRow({ activatable: false, selectable: false });
        more.child = new Gtk.Label({ label: `${texts.length - PER_SESSION} autre${texts.length - PER_SESSION > 1 ? 's' : ''} dans cette session`, xalign: 0, marginStart: 54, cssClasses: ['dim-label', 'caption'] });
        list.append(more);
      }
    }
    const count = hits.length;
    if (count === 0) {
      empty.title = 'Aucun résultat';
      empty.description = esc(`Rien ne correspond à « ${entry.text.trim()} ».`);
      stack.visibleChildName = 'empty';
    } else stack.visibleChildName = 'list';
    const summary = count === 0 ? '' : `${count >= 200 ? '200+' : count} résultat${count > 1 ? 's' : ''} dans ${groups.size} session${groups.size > 1 ? 's' : ''}`;
    status.label = [summary, indexing].filter((x) => x !== '').join(' · ');
  };

  let queued = 0;
  const later = (): void => {
    if (queued !== 0) GLib.source_remove(queued);
    queued = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
      queued = 0;
      render();
      return GLib.SOURCE_REMOVE;
    });
  };
  entry.connect('search-changed', later);
  projectDD.connect('notify::selected', render);
  periodDD.connect('notify::selected', render);
  dialog.connect('closed', () => {
    if (queued !== 0) GLib.source_remove(queued);
  });

  const activate = (row: Gtk.ListBoxRow | null): void => {
    const hit = row === null ? undefined : targets.get(row);
    if (hit === undefined) return;
    dialog.close();
    o.open(hit.session.id, hit.text?.message ?? null, hit.text?.part ?? null);
  };
  list.connect('row-activated', (_l: Gtk.ListBox, row: Gtk.ListBoxRow) => activate(row));
  // Entrée : premier résultat ; Bas : vers la liste
  entry.connect('activate', () => {
    // premier message trouvé (la première ligne est l'en-tête de sa session)
    let first: Gtk.ListBoxRow | null = null;
    for (const [row, hit] of targets) {
      if (hit.text !== null) {
        first = row;
        break;
      }
    }
    activate(first ?? list.get_row_at_index(0));
  });
  const keys = new Gtk.EventControllerKey();
  keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number) => {
    if (keyval !== Gdk.KEY_Down) return false;
    const first = list.get_row_at_index(0);
    if (first === null) return false;
    list.select_row(first);
    first.grab_focus();
    return true;
  });
  entry.add_controller(keys);

  // index mis à jour à chaque ouverture (sessions nouvelles ou modifiées seulement)
  let open = true;
  dialog.connect('closed', () => {
    open = false;
  });
  o.index
    .refresh((done, total) => {
      if (!open) return;
      indexing = total === 0 || done >= total ? '' : `Indexation des conversations : ${done} / ${total}…`;
      if (done >= total || done % 10 === 0) render();
    })
    .then(() => {
      indexing = '';
      if (open) render();
      return null;
    })
    .catch((e: unknown) => {
      indexing = `Index incomplet : ${errorMessage(e)}`;
      if (open) render();
    });

  dialog.present(parent);
  render();
  entry.grab_focus();
}
