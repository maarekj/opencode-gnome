// Fichiers modifiés du dépôt git d'une session : liste à gauche, diff du fichier choisi à droite.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import type { Accessor } from 'gnim';
import { errorMessage } from '../shared/errors.ts';
import { esc } from '../shared/format.ts';
import type { FileDiff, VcsInfo } from '../shared/schemas.ts';

const MAX_PATCH = 200_000;

const STATUS: Readonly<Record<string, { icon: string; label: string; css: string }>> = {
  added: { icon: 'list-add-symbolic', label: 'Ajouté', css: 'success' },
  deleted: { icon: 'list-remove-symbolic', label: 'Supprimé', css: 'error' },
  modified: { icon: 'document-edit-symbolic', label: 'Modifié', css: 'accent' },
};
const statusOf = (f: FileDiff): { icon: string; label: string; css: string } => STATUS[f.status ?? 'modified'] ?? STATUS['modified'] ?? { icon: '', label: '', css: '' };

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const dirname = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Remplit un buffer avec un patch unifié coloré (tags), sans les entêtes `diff --git` / `index`. */
function fillPatch(buffer: Gtk.TextBuffer, patch: string): void {
  const table = buffer.get_tag_table();
  const tag = (name: string, props: Partial<Gtk.TextTag.ConstructorProps>): Gtk.TextTag => {
    const existing = table.lookup(name);
    if (existing !== null) return existing;
    const t = new Gtk.TextTag({ name, ...props });
    table.add(t);
    return t;
  };
  const tags = {
    add: tag('add', { foreground: '#26a269', paragraphBackground: 'rgba(38,162,105,0.10)' }),
    del: tag('del', { foreground: '#c01c28', paragraphBackground: 'rgba(192,28,40,0.10)' }),
    hunk: tag('hunk', { foreground: '#1c71d8', pixelsAboveLines: 8 }),
    meta: tag('meta', { scale: 0.9, style: Pango.Style.ITALIC }),
  };
  buffer.set_text('', -1);
  const text = patch.length > MAX_PATCH ? `${patch.slice(0, MAX_PATCH)}\n… (diff tronqué)` : patch;
  const lines = text.split('\n').filter((l) => !/^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode)/u.test(l));
  // évite une ligne vide finale
  if (lines.at(-1) === '') lines.pop();
  for (const [i, line] of lines.entries()) {
    const t = line.startsWith('@@') ? tags.hunk : line.startsWith('+') ? tags.add : line.startsWith('-') ? tags.del : line.startsWith('\\') ? tags.meta : null;
    const content = i === lines.length - 1 ? line : `${line}\n`;
    const offset = buffer.get_char_count();
    buffer.insert(buffer.get_end_iter(), content, -1);
    if (t !== null) buffer.apply_tag(t, buffer.get_iter_at_offset(offset), buffer.get_end_iter());
  }
}

function FileRow({ file }: { file: FileDiff }): JSX.Element {
  const st = statusOf(file);
  const dir = dirname(file.file);
  return (
    <Gtk.ListBoxRow name={file.file} tooltipText={`${st.label} : ${file.file}`}>
      <Gtk.Box spacing={10} marginTop={6} marginBottom={6} marginStart={6} marginEnd={6}>
        <Gtk.Image iconName={st.icon} cssClasses={[st.css]} />
        <Gtk.Box orientation={Gtk.Orientation.VERTICAL} hexpand>
          <Gtk.Label label={basename(file.file)} xalign={0} ellipsize={Pango.EllipsizeMode.MIDDLE} />
          {dir === '' ? null : <Gtk.Label label={dir} xalign={0} ellipsize={Pango.EllipsizeMode.START} cssClasses={['dim-label', 'caption']} />}
        </Gtk.Box>
        <Gtk.Label useMarkup cssClasses={['caption', 'numeric']} label={`<span foreground="#26a269">+${file.additions}</span> <span foreground="#c01c28">−${file.deletions}</span>`} />
      </Gtk.Box>
    </Gtk.ListBoxRow>
  );
}

export interface DiffSource {
  title: string;
  load: () => Promise<FileDiff[]>;
  vcs: () => Promise<VcsInfo>;
  /** Incrémenté quand des fichiers changent (rafraîchissement automatique). */
  changed?: Accessor<number>;
}

export function openDiffDialog(parent: Gtk.Widget, source: DiffSource): void {
  const dialog = new Adw.Dialog({ title: 'Fichiers modifiés', contentWidth: 1200, contentHeight: 800 });

  // ------------------------------------------------ diff (droite)
  const buffer = new Gtk.TextBuffer();
  const diffView = new Gtk.TextView({
    buffer,
    editable: false,
    cursorVisible: false,
    monospace: true,
    wrapMode: Gtk.WrapMode.CHAR,
    topMargin: 12,
    bottomMargin: 12,
    leftMargin: 12,
    rightMargin: 12,
    cssClasses: ['diff-view'],
  });
  const contentTitle = new Adw.WindowTitle({ title: '', subtitle: '' });
  const contentStack = new Gtk.Stack({ transitionType: Gtk.StackTransitionType.CROSSFADE });
  contentStack.add_named(new Gtk.ScrolledWindow({ child: diffView, vexpand: true }), 'diff');
  contentStack.add_named(new Adw.StatusPage({ iconName: 'document-edit-symbolic', title: 'Choisis un fichier' }), 'none');
  const contentHeader = new Adw.HeaderBar({ titleWidget: contentTitle });
  const contentView = new Adw.ToolbarView({ content: contentStack });
  contentView.add_top_bar(contentHeader);

  // ------------------------------------------------ liste (gauche)
  const list = new Gtk.ListBox({ cssClasses: ['navigation-sidebar'] });
  const sideTitle = new Adw.WindowTitle({ title: source.title, subtitle: '' });
  const refresh = new Gtk.Button({ iconName: 'view-refresh-symbolic', tooltipText: 'Rafraîchir' });
  const sideHeader = new Adw.HeaderBar({ titleWidget: sideTitle, showEndTitleButtons: false });
  sideHeader.pack_start(refresh);
  const sideStack = new Gtk.Stack();
  sideStack.add_named(new Adw.Spinner({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, widthRequest: 32, heightRequest: 32 }), 'loading');
  sideStack.add_named(new Gtk.ScrolledWindow({ child: list, vexpand: true, hscrollbarPolicy: Gtk.PolicyType.NEVER }), 'files');
  const empty = new Adw.StatusPage({ iconName: 'object-select-symbolic', title: 'Aucune modification', description: "L'arbre de travail git est propre." });
  empty.add_css_class('compact');
  sideStack.add_named(empty, 'empty');
  const error = new Adw.StatusPage({ iconName: 'dialog-error-symbolic', title: 'Impossible de lire git' });
  error.add_css_class('compact');
  sideStack.add_named(error, 'error');
  const sideView = new Adw.ToolbarView({ content: sideStack });
  sideView.add_top_bar(sideHeader);

  const split = new Adw.NavigationSplitView({
    sidebar: new Adw.NavigationPage({ title: 'Fichiers', child: sideView }),
    content: new Adw.NavigationPage({ title: 'Diff', child: contentView }),
    minSidebarWidth: 260,
    maxSidebarWidth: 380,
  });
  dialog.child = split;

  let files: FileDiff[] = [];
  let selected: string | null = null;

  const show = (file: FileDiff | null): void => {
    if (file === null) {
      contentTitle.title = '';
      contentTitle.subtitle = '';
      contentStack.visibleChildName = 'none';
      return;
    }
    selected = file.file;
    contentTitle.title = basename(file.file);
    contentTitle.subtitle = `${statusOf(file).label} · +${file.additions} −${file.deletions}`;
    fillPatch(buffer, file.patch ?? '');
    contentStack.visibleChildName = 'diff';
    split.showContent = true;
  };

  list.connect('row-selected', (_l: Gtk.ListBox, row: Gtk.ListBoxRow | null) => {
    if (row !== null) show(files.find((f) => f.file === row.name) ?? null);
  });

  let loading = false;
  const load = async (): Promise<void> => {
    if (loading) return;
    loading = true;
    if (files.length === 0) sideStack.visibleChildName = 'loading';
    try {
      const [loaded, vcs] = await Promise.all([source.load(), source.vcs().catch(() => null)]);
      files = loaded.toSorted((a, b) => a.file.localeCompare(b.file));
      sideTitle.subtitle = [vcs?.branch === undefined || vcs.branch === null ? '' : `⎇ ${vcs.branch}`, `${files.length} fichier${files.length > 1 ? 's' : ''}`]
        .filter((x) => x !== '')
        .join(' · ');
      for (let row = list.get_row_at_index(0); row !== null; row = list.get_row_at_index(0)) list.remove(row);
      for (const f of files) {
        const row = FileRow({ file: f });
        if (row instanceof Gtk.ListBoxRow) list.append(row);
      }
      sideStack.visibleChildName = files.length === 0 ? 'empty' : 'files';
      // garde le fichier sélectionné s'il est toujours modifié, sinon le premier
      const index = Math.max(0, files.findIndex((f) => f.file === selected));
      const row = list.get_row_at_index(index);
      if (row === null) show(null);
      else {
        list.select_row(row);
        show(files[index] ?? null);
      }
    } catch (e) {
      error.description = esc(errorMessage(e));
      sideStack.visibleChildName = 'error';
    }
    loading = false;
  };
  refresh.connect('clicked', () => void load());

  // rafraîchissement automatique (regroupé) quand l'agent modifie des fichiers
  let queued = 0;
  const unsubscribe = source.changed?.subscribe(() => {
    if (queued !== 0) return;
    queued = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
      queued = 0;
      void load();
      return GLib.SOURCE_REMOVE;
    });
  });
  dialog.connect('closed', () => {
    unsubscribe?.();
    if (queued !== 0) GLib.source_remove(queued);
  });

  dialog.present(parent);
  void load();
}
