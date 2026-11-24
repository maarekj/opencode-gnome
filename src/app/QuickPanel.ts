// Panneau d'actions rapide (Ctrl+P) : un champ de recherche et une liste au clavier — sessions
// (celles qui demandent l'attention d'abord : question, permission, réponse à lire, en cours),
// projets et actions de l'application.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { esc, fmtFullDate, fmtRelative } from '../shared/format.ts';
import { isWaiting, isWorking, prettyPath, type ProjectView, type SessionView } from '../shared/store.ts';
import { normalize } from './Sidebar.tsx';

/** Action proposée dans le panneau. */
export interface QuickAction {
  readonly icon: string;
  readonly label: string;
  /** raccourci ou précision, affiché en grisé */
  readonly detail?: string;
  readonly run: () => void;
}

export interface QuickOptions {
  readonly projects: () => readonly ProjectView[];
  readonly openSession: (sessionID: string) => void;
  readonly openProject: (key: string) => void;
  readonly actions: readonly QuickAction[];
}

/** sessions affichées au plus (champ vide : après celles à suivre ; recherche : résultats) */
const MAX_SESSIONS = 12;
const MAX_PROJECTS = 8;

/** Libellé grisé de droite d'une ligne. */
const dim = (label: string, css: readonly string[] = ['dim-label', 'caption']): Gtk.Label => new Gtk.Label({ label, cssClasses: [...css], ellipsize: Pango.EllipsizeMode.END, maxWidthChars: 28 });

/** État affiché d'une session, ou null si rien à signaler. */
function stateLabel(v: SessionView): { label: string; css: string } | null {
  switch (v.activity) {
    case 'busy':
      return { label: 'En cours', css: 'accent' };
    case 'retry':
      return { label: 'Nouvel essai', css: 'warning' };
    case 'background':
      return { label: `Tâches de fond${v.background === undefined ? '' : ` : ${v.background}`}`, css: 'accent' };
    case 'question':
      return { label: 'Question en attente', css: 'warning' };
    case 'permission':
      return { label: 'Permission demandée', css: 'warning' };
    case 'idle':
      return v.unread ? { label: 'Réponse à lire', css: 'accent' } : null;
    default:
      return null;
  }
}

/** dernière activité de la session */
const updatedOf = (v: SessionView): number => v.session.time.updated ?? v.session.time.created;

/** priorité d'une session « à suivre » (plus petit = plus haut) */
function attention(v: SessionView): number {
  if (isWaiting(v.activity)) return 0;
  if (v.unread) return 1;
  if (isWorking(v.activity)) return 2;
  return 3;
}

/** Tous les mots de `query` (normalisés) apparaissent dans `hay`. */
function matches(hay: string, query: readonly string[]): boolean {
  const h = normalize(hay);
  return query.every((w) => h.includes(w));
}

let current: Adw.Dialog | null = null;
/** re-rend et redonne le focus au champ du panneau déjà ouvert */
let refresh: (() => void) | null = null;

export function openQuickPanel(parent: Gtk.Widget, o: QuickOptions): void {
  if (current !== null) {
    current.present(parent);
    refresh?.();
    return;
  }
  const dialog = new Adw.Dialog({ title: 'Actions rapides', contentWidth: 620, contentHeight: 480 });
  current = dialog;
  dialog.connect('closed', () => {
    current = null;
    refresh = null;
  });

  const entry = new Gtk.SearchEntry({ placeholderText: 'Session, projet ou action…', hexpand: true, marginStart: 12, marginEnd: 12, marginTop: 6, marginBottom: 6 });
  // nom accessible (lecteurs d'écran, tests) : le texte d'aide n'est pas exposé
  entry.update_property([Gtk.AccessibleProperty.LABEL], ['Actions rapides']);
  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.BROWSE, cssClasses: ['navigation-sidebar'] });
  const empty = new Adw.StatusPage({ iconName: 'system-search-symbolic', title: 'Aucun résultat', vexpand: true, cssClasses: ['compact'] });
  const stack = new Gtk.Stack({ vexpand: true });
  stack.add_named(empty, 'empty');
  stack.add_named(new Gtk.ScrolledWindow({ child: list, hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true }), 'list');

  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  content.append(entry);
  content.append(stack);
  const view = new Adw.ToolbarView({ content });
  view.add_top_bar(new Adw.HeaderBar());
  dialog.child = view;

  /** action de chaque ligne activable */
  const targets = new Map<Gtk.ListBoxRow, () => void>();

  const header = (label: string): void => {
    const row = new Gtk.ListBoxRow({ activatable: false, selectable: false });
    row.child = new Gtk.Label({ label, xalign: 0, marginStart: 8, marginTop: 8, marginBottom: 2, cssClasses: ['dim-label', 'caption-heading'] });
    list.append(row);
  };

  const row = (icon: string, label: string, right: readonly Gtk.Widget[], tooltip: string, run: () => void): void => {
    const r = new Gtk.ListBoxRow({ activatable: true, tooltipText: tooltip });
    const box = new Gtk.Box({ spacing: 8, marginStart: 6, marginEnd: 6, marginTop: 4, marginBottom: 4 });
    box.append(new Gtk.Image({ iconName: icon, cssClasses: ['dim-label'] }));
    box.append(new Gtk.Label({ label, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END }));
    for (const w of right) box.append(w);
    r.child = box;
    list.append(r);
    targets.set(r, run);
  };

  const sessionRow = (v: SessionView, project: ProjectView): void => {
    const state = stateLabel(v);
    const right: Gtk.Widget[] = [...(state === null ? [] : [dim(state.label, [state.css, 'caption'])]), dim(project.name), dim(fmtRelative(updatedOf(v)))];
    const title = v.session.title === '' ? 'Sans titre' : v.session.title;
    row('chat-message-new-symbolic', title, right, `${project.name} — ${fmtFullDate(updatedOf(v))}`, () => o.openSession(v.session.id));
  };

  const render = (): void => {
    for (let r = list.get_row_at_index(0); r !== null; r = list.get_row_at_index(0)) list.remove(r);
    targets.clear();
    const query = normalize(entry.text).split(/\s+/u).filter((w) => w !== '');
    const projects = o.projects();
    const sessions = projects.flatMap((p) => p.sessions.map((v) => ({ v, p }))).toSorted((a, b) => updatedOf(b.v) - updatedOf(a.v));

    if (query.length === 0) {
      const follow = sessions.filter(({ v }) => attention(v) < 3).toSorted((a, b) => attention(a.v) - attention(b.v) || updatedOf(b.v) - updatedOf(a.v));
      if (follow.length > 0) {
        header('À suivre');
        for (const { v, p } of follow.slice(0, MAX_SESSIONS)) sessionRow(v, p);
      }
      const recent = sessions.filter(({ v }) => attention(v) === 3).slice(0, Math.max(3, MAX_SESSIONS - follow.length));
      if (recent.length > 0) {
        header('Sessions récentes');
        for (const { v, p } of recent) sessionRow(v, p);
      }
    }

    // recherche : projets avant les sessions (moins nombreux, plus vite repérés)
    const foundProjects = (query.length === 0 ? projects.toSorted((a, b) => b.updated - a.updated) : projects.filter((p) => matches(`${p.name} ${p.path}`, query))).slice(0, MAX_PROJECTS);
    if (foundProjects.length > 0) {
      header('Projets');
      for (const p of foundProjects) row('folder-symbolic', p.name, [dim(prettyPath(p.path))], prettyPath(p.path), () => o.openProject(p.key));
    }

    if (query.length > 0) {
      const found = sessions.filter(({ v, p }) => matches(`${v.session.title} ${p.name}`, query)).slice(0, MAX_SESSIONS);
      if (found.length > 0) {
        header('Sessions');
        for (const { v, p } of found) sessionRow(v, p);
      }
    }

    const foundActions = query.length === 0 ? o.actions : o.actions.filter((a) => matches(a.label, query));
    if (foundActions.length > 0) {
      header('Actions');
      for (const a of foundActions) row(a.icon, a.label, a.detail === undefined ? [] : [dim(a.detail)], '', a.run);
    }

    stack.visibleChildName = targets.size === 0 ? 'empty' : 'list';
    // la description est du markup Pango : texte saisi échappé
    empty.description = `Rien ne correspond à « ${esc(entry.text.trim())} ».`;
  };

  entry.connect('search-changed', render);

  const activate = (r: Gtk.ListBoxRow | null): void => {
    const run = r === null ? undefined : targets.get(r);
    if (run === undefined) return;
    dialog.close();
    run();
  };
  list.connect('row-activated', (_l: Gtk.ListBox, r: Gtk.ListBoxRow) => activate(r));
  // Entrée : ligne sélectionnée, sinon la première ; Bas : vers la liste
  entry.connect('activate', () => {
    const selected = list.get_selected_row();
    if (selected !== null && targets.has(selected)) {
      activate(selected);
      return;
    }
    for (const r of targets.keys()) {
      activate(r);
      return;
    }
  });
  const keys = new Gtk.EventControllerKey();
  keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number) => {
    if (keyval !== Gdk.KEY_Down) return false;
    for (const r of targets.keys()) {
      list.select_row(r);
      r.grab_focus();
      return true;
    }
    return false;
  });
  entry.add_controller(keys);

  refresh = (): void => {
    render();
    entry.grab_focus();
  };
  dialog.present(parent);
  render();
  // la liste bouge pendant la frappe : premier rendu fait, focus sur le champ
  GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    entry.grab_focus();
    return GLib.SOURCE_REMOVE;
  });
}
