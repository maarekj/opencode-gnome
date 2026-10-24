// Fenêtre git d'un dossier (lecture seule), à onglets : Modifications (arbre de travail), Journal
// (commits et leur détail), Branches (branches, worktrees, tags). Fenêtre séparée non modale, une
// par répertoire : la conversation reste utilisable à côté.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import type { Accessor } from 'gnim';
import { errorMessage } from '../shared/errors.ts';
import { esc, fmtFullDate, fmtRelative } from '../shared/format.ts';
import { gitChanges, gitCommit, gitFilePatch, gitLog, gitRefs, gitStatus, gitResolve, commitGraph, type GitCommit, type GitFileChange, type GitRef, type GraphEdge, type GraphRow } from '../shared/git.ts';
import type { FileDiff } from '../shared/schemas.ts';
import { prettyPath } from '../shared/store.ts';
import { createDiffView } from './DiffView.ts';

const LOG_PAGE = 300;

const STATUS: Readonly<Record<string, { icon: string; label: string; css: string }>> = {
  A: { icon: 'list-add-symbolic', label: 'Ajouté', css: 'success' },
  D: { icon: 'list-remove-symbolic', label: 'Supprimé', css: 'error' },
  M: { icon: 'document-edit-symbolic', label: 'Modifié', css: 'accent' },
  R: { icon: 'go-next-symbolic', label: 'Renommé', css: 'accent' },
  C: { icon: 'edit-copy-symbolic', label: 'Copié', css: 'accent' },
  T: { icon: 'document-edit-symbolic', label: 'Type modifié', css: 'accent' },
};
const statusOf = (code: string): { icon: string; label: string; css: string } => STATUS[code] ?? STATUS['M'] ?? { icon: '', label: '', css: '' };
/** statut du serveur (`added`…) -> code git */
const SERVER_STATUS: Readonly<Record<string, string>> = { added: 'A', deleted: 'D', modified: 'M' };

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const dirname = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const plural = (n: number, word: string): string => `${n} ${word}${n > 1 ? 's' : ''}`;

export interface GitSource {
  /** répertoire du dépôt : une seule fenêtre par répertoire */
  directory: string;
  title: string;
  /** modifications de l'arbre de travail (serveur opencode) */
  load: () => Promise<FileDiff[]>;
  /** Incrémenté quand des fichiers changent (rafraîchissement automatique). */
  changed?: Accessor<number>;
}

export type GitTab = 'changes' | 'log' | 'branches' | 'compare';

// ------------------------------------------------------------------ éléments communs

function clearList(list: Gtk.ListBox): void {
  for (let row = list.get_row_at_index(0); row !== null; row = list.get_row_at_index(0)) list.remove(row);
}

function statusPage(icon: string, title: string, description = ''): Adw.StatusPage {
  const page = new Adw.StatusPage({ iconName: icon, title, description });
  page.add_css_class('compact');
  return page;
}

/** Barre de titre d'un volet (sans HeaderBar : la fenêtre n'en a qu'une). */
function paneHeader(title: Gtk.Label, subtitle: Gtk.Label, ...extra: Gtk.Widget[]): Gtk.Box {
  const texts = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, valign: Gtk.Align.CENTER });
  texts.append(title);
  texts.append(subtitle);
  const box = new Gtk.Box({ spacing: 6, cssClasses: ['git-pane-header'] });
  box.append(texts);
  for (const w of extra) box.append(w);
  return box;
}

const headerTitle = (): Gtk.Label => new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.MIDDLE, cssClasses: ['heading'] });
const headerSubtitle = (): Gtk.Label => new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['dim-label', 'caption'] });

function fileRow(file: GitFileChange): Gtk.ListBoxRow {
  const st = statusOf(file.status);
  const dir = dirname(file.path);
  const box = new Gtk.Box({ spacing: 10, marginTop: 6, marginBottom: 6, marginStart: 6, marginEnd: 6 });
  box.append(new Gtk.Image({ iconName: st.icon, cssClasses: [st.css] }));
  const names = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
  names.append(new Gtk.Label({ label: basename(file.path), xalign: 0, ellipsize: Pango.EllipsizeMode.MIDDLE }));
  const sub = file.from === undefined ? dir : `← ${file.from}`;
  if (sub !== '') names.append(new Gtk.Label({ label: sub, xalign: 0, ellipsize: Pango.EllipsizeMode.START, cssClasses: ['dim-label', 'caption'] }));
  box.append(names);
  const stat =
    file.additions === null ? 'binaire' : `<span foreground="#26a269">+${file.additions}</span> <span foreground="#c01c28">−${file.deletions ?? 0}</span>`;
  box.append(new Gtk.Label({ label: stat, useMarkup: true, cssClasses: ['caption', 'numeric'] }));
  const tooltip = file.from === undefined ? `${st.label} : ${file.path}` : `${st.label} : ${file.from} → ${file.path}`;
  return new Gtk.ListBoxRow({ child: box, tooltipText: tooltip });
}

const noPatch = (): Promise<string> => Promise.resolve('');

/** Liste de fichiers modifiés et diff du fichier choisi (patch chargé à la demande). */
function createFilesPane(): {
  readonly widget: Gtk.Widget;
  show: (files: readonly GitFileChange[], patch: (f: GitFileChange) => Promise<string>, keep?: string | null) => void;
  readonly selected: () => string | null;
} {
  const list = new Gtk.ListBox({ cssClasses: ['navigation-sidebar'] });
  const listBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  listBox.append(list);
  const diff = createDiffView();
  const title = headerTitle();
  const subtitle = headerSubtitle();
  const stack = new Gtk.Stack({ transitionType: Gtk.StackTransitionType.CROSSFADE, vexpand: true });
  stack.add_named(diff.widget, 'diff');
  stack.add_named(statusPage('document-edit-symbolic', 'Choisis un fichier'), 'none');
  stack.add_named(statusPage('object-select-symbolic', 'Aucun fichier modifié'), 'empty');
  stack.add_named(new Adw.Spinner({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, widthRequest: 32, heightRequest: 32 }), 'loading');
  const errorPage = statusPage('dialog-error-symbolic', 'Diff illisible');
  stack.add_named(errorPage, 'error');
  const right = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  right.append(paneHeader(title, subtitle));
  right.append(new Gtk.Separator());
  right.append(stack);

  let files: readonly GitFileChange[] = [];
  let patchOf: (f: GitFileChange) => Promise<string> = noPatch;
  let selected: string | null = null;
  let generation = 0;

  const open = (file: GitFileChange | null): void => {
    const gen = ++generation;
    if (file === null) {
      selected = null;
      title.label = '';
      subtitle.label = '';
      stack.visibleChildName = 'none';
      return;
    }
    selected = file.path;
    title.label = file.path;
    subtitle.label = [statusOf(file.status).label, file.from === undefined ? '' : `depuis ${file.from}`, file.additions === null ? 'binaire' : `+${file.additions} −${file.deletions ?? 0}`]
      .filter((x) => x !== '')
      .join(' · ');
    stack.visibleChildName = 'loading';
    void (async () => {
      try {
        const patch = await patchOf(file);
        if (gen !== generation) return;
        diff.show(file.path, patch);
        stack.visibleChildName = 'diff';
      } catch (e) {
        if (gen !== generation) return;
        errorPage.description = esc(errorMessage(e));
        stack.visibleChildName = 'error';
      }
    })();
  };

  list.connect('row-selected', (_l: Gtk.ListBox, row: Gtk.ListBoxRow | null) => {
    if (row === null) return;
    const file = files[row.get_index()];
    if (file !== undefined && file.path !== selected) open(file);
  });

  const show = (next: readonly GitFileChange[], patch: (f: GitFileChange) => Promise<string>, keep: string | null = null): void => {
    files = next;
    patchOf = patch;
    selected = null;
    clearList(list);
    for (const f of files) list.append(fileRow(f));
    // garde le fichier choisi s'il est toujours là, sinon le premier
    const index = Math.max(0, files.findIndex((f) => f.path === keep));
    const row = list.get_row_at_index(index);
    if (row === null) {
      open(null);
      stack.visibleChildName = 'empty';
    } else {
      list.select_row(row);
      open(files[index] ?? null);
    }
  };

  const paned = new Gtk.Paned({
    startChild: new Gtk.ScrolledWindow({ child: listBox, hscrollbarPolicy: Gtk.PolicyType.NEVER, widthRequest: 220 }),
    endChild: right,
    position: 300,
    shrinkStartChild: false,
    shrinkEndChild: false,
    vexpand: true,
  });
  return { widget: paned, show, selected: () => selected };
}

// ------------------------------------------------------------------ Modifications

function changesTab(source: GitSource): { widget: Gtk.Widget; load: () => Promise<void> } {
  const pane = createFilesPane();
  const stack = new Gtk.Stack();
  stack.add_named(new Adw.Spinner({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, widthRequest: 32, heightRequest: 32 }), 'loading');
  stack.add_named(pane.widget, 'files');
  stack.add_named(statusPage('object-select-symbolic', 'Aucune modification', "L'arbre de travail git est propre."), 'empty');
  const error = statusPage('dialog-error-symbolic', 'Impossible de lire git');
  stack.add_named(error, 'error');
  let loaded = false;
  let last = '';
  const load = async (): Promise<void> => {
    if (!loaded) stack.visibleChildName = 'loading';
    try {
      const diffs = (await source.load()).toSorted((a, b) => a.file.localeCompare(b.file));
      // rien de changé : on garde la vue (défilement du diff)
      const key = JSON.stringify(diffs);
      if (loaded && key === last) return;
      last = key;
      const files = diffs.map((d): GitFileChange => ({ path: d.file, status: SERVER_STATUS[d.status ?? 'modified'] ?? 'M', additions: d.additions, deletions: d.deletions }));
      const patches = new Map(diffs.map((d) => [d.file, d.patch ?? '']));
      pane.show(files, (f) => Promise.resolve(patches.get(f.path) ?? ''), pane.selected());
      stack.visibleChildName = files.length === 0 ? 'empty' : 'files';
      loaded = true;
    } catch (e) {
      error.description = esc(errorMessage(e));
      stack.visibleChildName = 'error';
    }
  };
  return { widget: stack, load };
}

// ------------------------------------------------------------------ Journal

/** Étiquettes des refs d'un commit (`HEAD -> main`, `origin/main`, `tag: v1`). */
function refBadges(refs: readonly string[]): Gtk.Widget[] {
  return refs.map((r) => {
    const head = r.startsWith('HEAD -> ');
    const tag = r.startsWith('tag: ');
    const label = head ? r.slice(8) : tag ? r.slice(5) : r;
    const css = head ? 'ref-head' : tag ? 'ref-tag' : r.includes('/') ? 'ref-remote' : 'ref-branch';
    return new Gtk.Label({ label, cssClasses: ['caption', 'ref-badge', css], tooltipText: head ? `${label} (branche actuelle)` : tag ? `Tag ${label}` : label });
  });
}

// ---- graphe : couleurs des voies (palette GNOME), dimensions en pixels
const LANE_COLORS: readonly (readonly [number, number, number])[] = [
  [0.21, 0.52, 0.89], // bleu
  [0.18, 0.76, 0.49], // vert
  [0.9, 0.38, 0], // orange
  [0.57, 0.25, 0.67], // violet
  [0.88, 0.11, 0.14], // rouge
  [0.13, 0.63, 0.62], // sarcelle
  [0.96, 0.76, 0.07], // jaune
  [0.6, 0.4, 0.27], // brun
];
const LANE_W = 14;
const LANE_PAD = 9;
/** hauteur du point : au niveau de la première ligne (titre du commit) */
const DOT_Y = 16;
const MAX_LANES = 12;

const laneX = (k: number): number => LANE_PAD + Math.min(k, MAX_LANES - 1) * LANE_W;

/** Dessin d'une ligne du graphe (traits continus d'une ligne à l'autre : la liste n'a pas d'espacement). */
function graphCell(row: GraphRow, width: number, merge: boolean): Gtk.DrawingArea {
  const area = new Gtk.DrawingArea({ widthRequest: LANE_PAD * 2 + (Math.min(width, MAX_LANES) - 1) * LANE_W, vexpand: true });
  area.set_draw_func((_a, cr, _w, h) => {
    cr.setLineWidth(2);
    const color = (i: number, alpha = 1): void => {
      const [r, g, b] = LANE_COLORS[i % LANE_COLORS.length] ?? [0.5, 0.5, 0.5];
      cr.setSourceRGBA(r, g, b, alpha);
    };
    const edge = (e: GraphEdge, y1: number, y2: number, bendAtEnd: boolean): void => {
      const x1 = laneX(e.from);
      const x2 = laneX(e.to);
      color(e.color);
      cr.moveTo(x1, y1);
      if (x1 === x2) cr.lineTo(x2, y2);
      // courbe : le changement de voie se fait près du point du commit
      else if (bendAtEnd) cr.curveTo(x1, y2 - 4, x2, y1 + (y2 - y1) / 2, x2, y2);
      else cr.curveTo(x1, y1 + (y2 - y1) / 2, x2, y1 + 4, x2, y2);
      cr.stroke();
    };
    for (const e of row.up) edge(e, 0, DOT_Y, e.from !== e.to);
    for (const e of row.down) edge(e, DOT_Y, h, false);
    // point du commit ; anneau pour une fusion
    color(row.color);
    cr.arc(laneX(row.col), DOT_Y, merge ? 5 : 4.5, 0, 2 * Math.PI);
    cr.fill();
    if (merge) {
      cr.setSourceRGBA(1, 1, 1, 1);
      cr.arc(laneX(row.col), DOT_Y, 2.2, 0, 2 * Math.PI);
      cr.fill();
    }
    cr.$dispose();
  });
  return area;
}

function commitRow(c: GitCommit, graph: GraphRow | undefined, width: number): Gtk.ListBoxRow {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, marginTop: 6, marginBottom: 6, marginEnd: 6, hexpand: true });
  box.append(new Gtk.Label({ label: c.subject, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END }));
  const meta = `${c.short} · ${c.author} · ${fmtRelative(c.date)}${c.parents.length > 1 ? ' · fusion' : ''}`;
  box.append(new Gtk.Label({ label: meta, xalign: 0, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['dim-label', 'caption'] }));
  // branches et tags du commit : ligne à part, repliée sur plusieurs lignes si besoin
  const badges = refBadges(c.refs.filter((r) => r !== 'HEAD'));
  if (badges.length > 0) {
    const flow = new Gtk.FlowBox({ selectionMode: Gtk.SelectionMode.NONE, columnSpacing: 4, rowSpacing: 4, maxChildrenPerLine: 20, marginTop: 2, canTarget: false });
    for (const b of badges) flow.append(b);
    box.append(flow);
  }
  const line = new Gtk.Box({ spacing: 4 });
  if (graph === undefined) box.marginStart = 6;
  else line.append(graphCell(graph, width, c.parents.length > 1));
  line.append(box);
  return new Gtk.ListBoxRow({ child: line, tooltipText: `${c.subject}\n${c.hash}\n${c.author} <${c.email}>\n${fmtFullDate(c.date)}` });
}

function logTab(directory: string, compare: (from: string, to: string) => void): { widget: Gtk.Widget; load: () => Promise<void>; showRef: (ref: string, label: string) => void } {
  // ---- liste des commits (gauche)
  const list = new Gtk.ListBox({ cssClasses: ['navigation-sidebar', 'git-log'] });
  const more = new Gtk.Button({ label: 'Afficher plus', cssClasses: ['flat'], marginTop: 6, marginBottom: 12, halign: Gtk.Align.CENTER, visible: false });
  const listBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  listBox.append(list);
  listBox.append(more);
  const refTitle = headerTitle();
  const refSubtitle = headerSubtitle();
  const backToHead = new Gtk.Button({ iconName: 'go-home-symbolic', tooltipText: 'Revenir à la branche actuelle', cssClasses: ['flat'], visible: false, valign: Gtk.Align.CENTER });
  const allBranches = new Gtk.ToggleButton({ iconName: 'media-playlist-consecutive-symbolic', tooltipText: 'Toutes les branches', cssClasses: ['flat'], valign: Gtk.Align.CENTER });
  const left = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, widthRequest: 280 });
  left.append(paneHeader(refTitle, refSubtitle, backToHead, allBranches));
  left.append(new Gtk.Separator());
  const leftStack = new Gtk.Stack({ vexpand: true });
  leftStack.add_named(new Adw.Spinner({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, widthRequest: 32, heightRequest: 32 }), 'loading');
  leftStack.add_named(new Gtk.ScrolledWindow({ child: listBox, hscrollbarPolicy: Gtk.PolicyType.NEVER }), 'list');
  const leftError = statusPage('dialog-error-symbolic', 'Journal illisible');
  leftStack.add_named(leftError, 'error');
  leftStack.add_named(statusPage('document-open-recent-symbolic', 'Aucun commit'), 'empty');
  left.append(leftStack);

  // ---- détail du commit (droite) : message, puis fichiers et diff
  const subject = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, cssClasses: ['title-4'] });
  const meta = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, useMarkup: true, cssClasses: ['dim-label', 'caption'] });
  const body = new Gtk.Label({ xalign: 0, yalign: 0, wrap: true, selectable: true, wrapMode: Pango.WrapMode.WORD_CHAR, cssClasses: ['monospace', 'commit-body'] });
  const copyHash = new Gtk.Button({ iconName: 'edit-copy-symbolic', tooltipText: "Copier l'identifiant du commit", cssClasses: ['flat'], valign: Gtk.Align.START });
  const info = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, cssClasses: ['commit-info'] });
  const infoTop = new Gtk.Box({ spacing: 6 });
  const infoTexts = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, hexpand: true });
  infoTexts.append(subject);
  infoTexts.append(meta);
  infoTop.append(infoTexts);
  const compareBtn = new Gtk.Button({ iconName: 'object-flip-horizontal-symbolic', tooltipText: 'Comparer ce commit avec la branche actuelle', cssClasses: ['flat'], valign: Gtk.Align.START });
  compareBtn.connect('clicked', () => {
    if (current !== null) compare(current.slice(0, 12), 'HEAD');
  });
  infoTop.append(compareBtn);
  infoTop.append(copyHash);
  info.append(infoTop);
  const bodyScroll = new Gtk.ScrolledWindow({ child: body, hscrollbarPolicy: Gtk.PolicyType.NEVER, propagateNaturalHeight: true, maxContentHeight: 180 });
  info.append(bodyScroll);
  const files = createFilesPane();
  const detail = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  detail.append(info);
  detail.append(new Gtk.Separator());
  detail.append(files.widget);
  const rightStack = new Gtk.Stack({ transitionType: Gtk.StackTransitionType.CROSSFADE });
  rightStack.add_named(statusPage('document-open-recent-symbolic', 'Choisis un commit'), 'none');
  rightStack.add_named(new Adw.Spinner({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, widthRequest: 32, heightRequest: 32 }), 'loading');
  rightStack.add_named(detail, 'commit');
  const rightError = statusPage('dialog-error-symbolic', 'Commit illisible');
  rightStack.add_named(rightError, 'error');

  let ref = 'HEAD';
  let refLabel = '';
  let commits: GitCommit[] = [];
  let limit = LOG_PAGE;
  let current: string | null = null;
  let generation = 0;

  const showCommit = (c: GitCommit | null): void => {
    const gen = ++generation;
    current = c?.hash ?? null;
    if (c === null) {
      rightStack.visibleChildName = 'none';
      return;
    }
    rightStack.visibleChildName = 'loading';
    const target = { commit: c.hash };
    void (async () => {
      try {
        const [full, changes] = await Promise.all([gitCommit(directory, c.hash), gitChanges(directory, target)]);
        if (gen !== generation) return;
        const lines = full.body.split('\n');
        subject.label = lines[0] ?? full.subject;
        const rest = lines.slice(1).join('\n').trim();
        body.label = rest;
        bodyScroll.visible = rest !== '';
        const committer = full.committer === full.author ? '' : `\nValidé par ${esc(full.committer)} le ${esc(fmtFullDate(full.committed))}`;
        const parents = full.parents.length > 1 ? `\nFusion de ${full.parents.map((p) => p.slice(0, 7)).join(' et ')}` : '';
        meta.label = `<b>${esc(full.author)}</b> &lt;${esc(full.email)}&gt; · ${esc(fmtFullDate(full.date))}\n<tt>${full.hash}</tt> · ${esc(plural(changes.length, 'fichier'))}${committer}${esc(parents)}`;
        copyHash.tooltipText = `Copier ${full.hash}`;
        files.show(changes, (f) => gitFilePatch(directory, target, f));
        rightStack.visibleChildName = 'commit';
      } catch (e) {
        if (gen !== generation) return;
        rightError.description = esc(errorMessage(e));
        rightStack.visibleChildName = 'error';
      }
    })();
  };

  copyHash.connect('clicked', () => {
    if (current !== null) copyHash.get_clipboard().set_content(Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', new GLib.Bytes(new TextEncoder().encode(current))));
  });

  list.connect('row-selected', (_l: Gtk.ListBox, row: Gtk.ListBoxRow | null) => {
    if (row === null) return;
    const c = commits[row.get_index()];
    if (c !== undefined && c.hash !== current) showCommit(c);
  });

  let loading = false;
  const load = async (): Promise<void> => {
    if (loading) return;
    loading = true;
    if (commits.length === 0) leftStack.visibleChildName = 'loading';
    try {
      const all = allBranches.active;
      const next = await gitLog(directory, all ? ['--branches', '--remotes', '--tags', 'HEAD'] : [ref], limit + 1);
      // même journal (rafraîchissement sans nouveau commit) : rien à reconstruire
      const same = next.length === commits.length + (more.visible ? 1 : 0) && commits.every((c, i) => c.hash === next[i]?.hash && c.refs.join() === next[i]?.refs.join());
      if (same && commits.length > 0) {
        loading = false;
        return;
      }
      more.visible = next.length > limit;
      commits = next.slice(0, limit);
      if (all) refTitle.label = 'Toutes les branches';
      else if (ref === 'HEAD') {
        const g = await gitStatus(directory);
        refTitle.label = g === null ? 'HEAD' : (g.branch ?? `HEAD détachée (${g.commit})`);
      } else refTitle.label = refLabel;
      refSubtitle.label = more.visible ? `${limit} derniers commits` : plural(commits.length, 'commit');
      backToHead.visible = ref !== 'HEAD' && !all;
      const keep = current;
      clearList(list);
      const graph = commitGraph(commits);
      for (const [i, c] of commits.entries()) list.append(commitRow(c, graph.rows[i], graph.width));
      leftStack.visibleChildName = commits.length === 0 ? 'empty' : 'list';
      // garde le commit choisi, sinon le plus récent
      const index = Math.max(0, commits.findIndex((c) => c.hash === keep));
      const row = list.get_row_at_index(index);
      if (row === null) showCommit(null);
      else {
        list.select_row(row);
        if (commits[index]?.hash !== keep) showCommit(commits[index] ?? null);
      }
    } catch (e) {
      leftError.description = esc(errorMessage(e));
      leftStack.visibleChildName = 'error';
    }
    loading = false;
  };
  more.connect('clicked', () => {
    limit += LOG_PAGE;
    void load();
  });
  const showRef = (r: string, label: string): void => {
    ref = r;
    refLabel = label;
    limit = LOG_PAGE;
    commits = [];
    current = null;
    // désactiver « toutes les branches » recharge déjà le journal
    if (allBranches.active) allBranches.active = false;
    else void load();
  };
  backToHead.connect('clicked', () => showRef('HEAD', ''));
  allBranches.connect('toggled', () => {
    limit = LOG_PAGE;
    commits = [];
    void load();
  });

  const paned = new Gtk.Paned({ startChild: left, endChild: rightStack, position: 380, shrinkStartChild: false, shrinkEndChild: false });
  return { widget: paned, load, showRef };
}

// ------------------------------------------------------------------ Comparer

/** Champ de saisie d'une ref, avec la liste des branches et tags à portée de clic. */
function refPicker(placeholder: string, refs: () => readonly GitRef[], changed: () => void): { widget: Gtk.Widget; entry: Gtk.Entry } {
  const entry = new Gtk.Entry({ placeholderText: placeholder, widthChars: 22, hexpand: true });
  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE, cssClasses: ['navigation-sidebar'] });
  const popover = new Gtk.Popover({ child: new Gtk.ScrolledWindow({ child: list, hscrollbarPolicy: Gtk.PolicyType.NEVER, propagateNaturalHeight: true, maxContentHeight: 460, widthRequest: 380 }) });
  const button = new Gtk.MenuButton({ iconName: 'pan-down-symbolic', popover, tooltipText: 'Choisir une branche ou un tag' });
  let all: readonly GitRef[] = [];
  list.connect('row-activated', (_l: Gtk.ListBox, row: Gtk.ListBoxRow) => {
    const r = all[row.get_index()];
    if (r === undefined) return;
    entry.text = r.short;
    popover.popdown();
    changed();
  });
  popover.connect('show', () => {
    clearList(list);
    all = refs();
    for (const r of all) {
      const texts = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
      texts.append(new Gtk.Label({ label: r.short, xalign: 0, ellipsize: Pango.EllipsizeMode.MIDDLE, cssClasses: r.current ? ['accent'] : [] }));
      texts.append(new Gtk.Label({ label: `${r.commit} · ${r.subject}`, xalign: 0, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['dim-label', 'caption'] }));
      const row = new Gtk.Box({ spacing: 10, marginTop: 2, marginBottom: 2 });
      row.append(new Gtk.Image({ iconName: r.current ? 'object-select-symbolic' : r.kind === 'tag' ? 'bookmark-new-symbolic' : r.kind === 'remote' ? 'network-server-symbolic' : 'media-playlist-consecutive-symbolic', cssClasses: r.current ? ['accent'] : ['dim-label'] }));
      row.append(texts);
      list.append(new Gtk.ListBoxRow({ child: row }));
    }
  });
  entry.connect('activate', changed);
  const box = new Gtk.Box({ cssClasses: ['linked'] });
  box.append(entry);
  box.append(button);
  return { widget: box, entry };
}

function compareTab(directory: string, openCommit: (hash: string) => void): { widget: Gtk.Widget; load: () => Promise<void>; set: (from: string, to: string) => void } {
  let refs: GitRef[] = [];
  const run = (): void => void load();
  const from = refPicker('Base (ex. main)', () => refs, run);
  const to = refPicker('Comparée (ex. HEAD, a1b2c3d)', () => refs, run);
  const swap = new Gtk.Button({ iconName: 'object-flip-horizontal-symbolic', tooltipText: 'Inverser', valign: Gtk.Align.CENTER });
  const mode = new Gtk.DropDown({ model: Gtk.StringList.new(["Depuis l'ancêtre commun", 'Différence directe']), valign: Gtk.Align.CENTER, tooltipText: "Depuis l'ancêtre commun : ce que la branche comparée apporte (git diff base...comparée).\nDifférence directe : tout ce qui sépare les deux états (git diff base comparée)." });
  const go = new Gtk.Button({ label: 'Comparer', cssClasses: ['suggested-action'], valign: Gtk.Align.CENTER });
  const bar = new Gtk.Box({ spacing: 8, cssClasses: ['compare-bar'] });
  bar.append(from.widget);
  bar.append(swap);
  bar.append(to.widget);
  bar.append(mode);
  bar.append(go);
  swap.connect('clicked', () => {
    const a = from.entry.text;
    from.entry.text = to.entry.text;
    to.entry.text = a;
    run();
  });
  go.connect('clicked', run);
  mode.connect('notify::selected', run);

  // ---- commits de chaque côté (gauche), fichiers et diff (droite)
  const commitList = new Gtk.ListBox({ cssClasses: ['navigation-sidebar'], selectionMode: Gtk.SelectionMode.NONE });
  const summary = headerTitle();
  const summarySub = headerSubtitle();
  const left = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, widthRequest: 260 });
  left.append(paneHeader(summary, summarySub));
  left.append(new Gtk.Separator());
  left.append(new Gtk.ScrolledWindow({ child: commitList, vexpand: true, hscrollbarPolicy: Gtk.PolicyType.NEVER }));
  const files = createFilesPane();
  const result = new Gtk.Paned({ startChild: left, endChild: files.widget, position: 320, shrinkStartChild: false, shrinkEndChild: false, vexpand: true });

  const stack = new Gtk.Stack({ vexpand: true });
  stack.add_named(statusPage('object-flip-horizontal-symbolic', 'Comparer deux branches ou commits', 'Choisis une base et une branche, un tag ou un commit à comparer.'), 'none');
  stack.add_named(new Adw.Spinner({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, widthRequest: 32, heightRequest: 32 }), 'loading');
  stack.add_named(result, 'result');
  const error = statusPage('dialog-error-symbolic', 'Comparaison impossible');
  stack.add_named(error, 'error');
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  box.append(bar);
  box.append(new Gtk.Separator());
  box.append(stack);

  let shown: (GitCommit | undefined)[] = [];
  commitList.connect('row-activated', (_l: Gtk.ListBox, row: Gtk.ListBoxRow) => {
    const c = shown[row.get_index()];
    if (c !== undefined) openCommit(c.hash);
  });

  let generation = 0;
  const load = async (): Promise<void> => {
    const gen = ++generation;
    if (refs.length === 0) refs = await gitRefs(directory).catch(() => []);
    const a = from.entry.text.trim();
    const b = to.entry.text.trim();
    if (a === '' || b === '') {
      stack.visibleChildName = 'none';
      return;
    }
    stack.visibleChildName = 'loading';
    try {
      const [ha, hb] = await Promise.all([gitResolve(directory, a), gitResolve(directory, b)]);
      if (ha === null || hb === null) throw new Error(`Référence introuvable : ${ha === null ? a : b}`);
      const mergeBase = mode.selected === 0;
      const target = { from: ha, to: hb, mergeBase };
      const [onlyB, onlyA, changes] = await Promise.all([gitLog(directory, [hb, `^${ha}`], 500), gitLog(directory, [ha, `^${hb}`], 500), gitChanges(directory, target)]);
      if (gen !== generation) return;
      // commits : d'abord ceux qu'apporte la comparée, puis ceux de la base absents de la comparée
      clearList(commitList);
      shown = [];
      const section = (title: string, list: GitCommit[]): void => {
        const head = new Gtk.ListBoxRow({ activatable: false, selectable: false, child: new Gtk.Label({ label: title, xalign: 0, cssClasses: ['heading', 'dim-label'], marginTop: 8, marginStart: 6 }) });
        commitList.append(head);
        shown.push(undefined);
        for (const c of list) {
          commitList.append(commitRow(c, undefined, 1));
          shown.push(c);
        }
      };
      section(`Seulement dans ${b} (${onlyB.length}${onlyB.length === 500 ? '+' : ''})`, onlyB);
      if (onlyA.length > 0) section(`Seulement dans ${a} (${onlyA.length}${onlyA.length === 500 ? '+' : ''})`, onlyA);
      summary.label = `${a} → ${b}`;
      const add = changes.reduce((n, f) => n + (f.additions ?? 0), 0);
      const del = changes.reduce((n, f) => n + (f.deletions ?? 0), 0);
      summarySub.label = `↑${onlyB.length} ↓${onlyA.length} · ${plural(changes.length, 'fichier')} · +${add} −${del}`;
      files.show(changes, (f) => gitFilePatch(directory, target, f), files.selected());
      stack.visibleChildName = 'result';
    } catch (e) {
      if (gen !== generation) return;
      error.description = esc(errorMessage(e));
      stack.visibleChildName = 'error';
    }
  };
  const set = (a: string, b: string): void => {
    from.entry.text = a;
    to.entry.text = b;
    run();
  };
  return { widget: box, load, set };
}

// ------------------------------------------------------------------ Branches

const TRACK = (t: string): string =>
  t
    .replace('[gone]', 'amont supprimé')
    .replaceAll(/ahead (\d+)/gu, '↑$1')
    .replaceAll(/behind (\d+)/gu, '↓$1')
    .replaceAll(/[[\],]/gu, '')
    .trim();

function refRow(r: GitRef, home: string, compare: (r: GitRef) => void): Gtk.ListBoxRow {
  const box = new Gtk.Box({ spacing: 10, marginTop: 6, marginBottom: 6, marginStart: 8, marginEnd: 8 });
  const icon = r.current ? 'object-select-symbolic' : r.kind === 'tag' ? 'bookmark-new-symbolic' : r.kind === 'remote' ? 'network-server-symbolic' : 'media-playlist-consecutive-symbolic';
  box.append(new Gtk.Image({ iconName: icon, cssClasses: r.current ? ['accent'] : ['dim-label'] }));
  const texts = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, spacing: 2 });
  const line = new Gtk.Box({ spacing: 8 });
  line.append(new Gtk.Label({ label: r.short, xalign: 0, ellipsize: Pango.EllipsizeMode.MIDDLE, cssClasses: r.current ? ['heading', 'accent'] : ['heading'] }));
  const track = TRACK(r.track);
  if (r.upstream !== '') line.append(new Gtk.Label({ label: track === '' ? `→ ${r.upstream}` : `→ ${r.upstream} ${track}`, cssClasses: ['dim-label', 'caption'] }));
  texts.append(line);
  texts.append(new Gtk.Label({ label: `${r.commit} · ${r.subject} · ${fmtRelative(r.date)}`, xalign: 0, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['dim-label', 'caption'] }));
  box.append(texts);
  if (r.worktree !== '' && r.worktree !== home) {
    box.append(new Gtk.Label({ label: `worktree ${GLib.path_get_basename(r.worktree)}`, tooltipText: prettyPath(r.worktree), valign: Gtk.Align.CENTER, cssClasses: ['caption', 'ref-badge', 'ref-branch'] }));
  }
  if (!r.current) {
    const cmp = new Gtk.Button({ iconName: 'object-flip-horizontal-symbolic', tooltipText: `Comparer ${r.short} avec la branche actuelle`, cssClasses: ['flat'], valign: Gtk.Align.CENTER });
    cmp.connect('clicked', () => compare(r));
    box.append(cmp);
  }
  box.append(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
  return new Gtk.ListBoxRow({ child: box, tooltipText: `Voir le journal de ${r.short}`, activatable: true });
}

function branchesTab(directory: string, openLog: (ref: string, label: string) => void, compare: (from: string, to: string) => void): { widget: Gtk.Widget; load: () => Promise<void> } {
  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 18, marginTop: 18, marginBottom: 18, marginStart: 18, marginEnd: 18 });
  const stack = new Gtk.Stack();
  stack.add_named(new Adw.Spinner({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, widthRequest: 32, heightRequest: 32 }), 'loading');
  stack.add_named(new Gtk.ScrolledWindow({ child: new Adw.Clamp({ child: content, maximumSize: 900 }), hscrollbarPolicy: Gtk.PolicyType.NEVER }), 'list');
  const error = statusPage('dialog-error-symbolic', 'Branches illisibles');
  stack.add_named(error, 'error');
  let loaded = false;
  let last = '';
  const load = async (): Promise<void> => {
    if (!loaded) stack.visibleChildName = 'loading';
    try {
      const [refs, status] = await Promise.all([gitRefs(directory), gitStatus(directory)]);
      const key = JSON.stringify(refs);
      if (loaded && key === last) return;
      last = key;
      for (let c = content.get_first_child(); c !== null; c = content.get_first_child()) content.remove(c);
      const sections: [string, GitRef[]][] = [
        ['Branches locales', refs.filter((r) => r.kind === 'branch').toSorted((a, b) => Number(b.current) - Number(a.current) || b.date - a.date)],
        ['Branches distantes', refs.filter((r) => r.kind === 'remote')],
        ['Tags', refs.filter((r) => r.kind === 'tag')],
      ];
      for (const [title, items] of sections) {
        if (items.length === 0) continue;
        const section = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
        section.append(new Gtk.Label({ label: `${title} (${items.length})`, xalign: 0, cssClasses: ['heading'] }));
        const list = new Gtk.ListBox({ cssClasses: ['boxed-list'], selectionMode: Gtk.SelectionMode.NONE });
        // la branche actuelle sert de base : on voit ce que l'autre apporte
        const head = status?.branch ?? 'HEAD';
        for (const r of items) list.append(refRow(r, status?.toplevel ?? directory, (o) => compare(head, o.short)));
        list.connect('row-activated', (_l: Gtk.ListBox, row: Gtk.ListBoxRow) => {
          const r = items[row.get_index()];
          if (r !== undefined) openLog(r.name, r.short);
        });
        section.append(list);
        content.append(section);
      }
      stack.visibleChildName = 'list';
      loaded = true;
    } catch (e) {
      error.description = esc(errorMessage(e));
      stack.visibleChildName = 'error';
    }
  };
  return { widget: stack, load };
}

// ------------------------------------------------------------------ fenêtre

/** Fenêtres ouvertes, par répertoire. */
const windows = new Map<string, { window: Adw.Window; stack: Adw.ViewStack }>();

export function openGitWindow(parent: Gtk.Widget, source: GitSource, tab: GitTab = 'changes'): void {
  const existing = windows.get(source.directory);
  if (existing !== undefined) {
    existing.stack.visibleChildName = tab;
    existing.window.present();
    return;
  }
  const root = parent.get_root();
  const app = root instanceof Gtk.Window ? root.application : null;
  const dialog = new Adw.Window({ title: `Git — ${source.title}`, defaultWidth: 1300, defaultHeight: 850, ...(app === null ? {} : { application: app }) });

  const stack = new Adw.ViewStack({ vexpand: true });
  const changes = changesTab(source);
  const compareWith = (a: string, b: string): void => {
    compare.set(a, b);
    stack.visibleChildName = 'compare';
  };
  const log = logTab(source.directory, compareWith);
  const branches = branchesTab(
    source.directory,
    (ref, label) => {
      log.showRef(ref, label);
      stack.visibleChildName = 'log';
    },
    compareWith,
  );
  const compare = compareTab(source.directory, (hash) => {
    log.showRef(hash, hash.slice(0, 7));
    stack.visibleChildName = 'log';
  });
  stack.add_titled_with_icon(changes.widget, 'changes', 'Modifications', 'document-edit-symbolic');
  stack.add_titled_with_icon(log.widget, 'log', 'Journal', 'document-open-recent-symbolic');
  stack.add_titled_with_icon(branches.widget, 'branches', 'Branches', 'media-playlist-consecutive-symbolic');
  stack.add_titled_with_icon(compare.widget, 'compare', 'Comparer', 'object-flip-horizontal-symbolic');
  windows.set(source.directory, { window: dialog, stack });

  const title = new Adw.WindowTitle({ title: source.title, subtitle: prettyPath(source.directory) });
  const header = new Adw.HeaderBar({ titleWidget: new Adw.ViewSwitcher({ stack, policy: Adw.ViewSwitcherPolicy.WIDE }) });
  const refresh = new Gtk.Button({ iconName: 'view-refresh-symbolic', tooltipText: 'Rafraîchir (F5)' });
  header.pack_start(refresh);
  header.pack_start(title);
  const view = new Adw.ToolbarView({ content: stack });
  view.add_top_bar(header);
  dialog.content = view;

  // chaque onglet est chargé à sa première ouverture, puis rafraîchi à la demande
  const loaders: Record<GitTab, () => Promise<void>> = { changes: changes.load, log: log.load, branches: branches.load, compare: compare.load };
  const loaded = new Set<string>();
  const isTab = (name: string): name is GitTab => name in loaders;
  const loadVisible = (force: boolean): void => {
    const name = stack.visibleChildName ?? '';
    if (!isTab(name) || (!force && loaded.has(name))) return;
    loaded.add(name);
    void loaders[name]();
  };
  stack.connect('notify::visible-child-name', () => loadVisible(false));
  const reloadAll = (): void => {
    loaded.clear();
    loadVisible(true);
  };
  refresh.connect('clicked', reloadAll);

  // Échap ferme la fenêtre, F5 rafraîchit
  const keys = new Gtk.EventControllerKey();
  keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number) => {
    if (keyval === Gdk.KEY_Escape) dialog.close();
    else if (keyval === Gdk.KEY_F5) reloadAll();
    else return false;
    return true;
  });
  dialog.add_controller(keys);

  // rafraîchissement automatique (regroupé) quand l'agent modifie des fichiers
  let queued = 0;
  const unsubscribe = source.changed?.subscribe(() => {
    if (queued !== 0) return;
    queued = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
      queued = 0;
      reloadAll();
      return GLib.SOURCE_REMOVE;
    });
  });
  // retour sur la fenêtre : un commit a pu avoir lieu ailleurs
  dialog.connect('notify::is-active', () => {
    if (dialog.isActive && loaded.size > 0) reloadAll();
  });
  dialog.connect('close-request', () => {
    unsubscribe?.();
    if (queued !== 0) GLib.source_remove(queued);
    windows.delete(source.directory);
    return false;
  });

  stack.visibleChildName = tab;
  dialog.present();
  loadVisible(true);
}
