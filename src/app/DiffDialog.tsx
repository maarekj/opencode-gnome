// Fichiers modifiés par une session, avec leur diff coloré.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { esc } from '../shared/format.ts';
import type { FileDiff } from '../shared/schemas.ts';

const MAX_PATCH = 60_000;

/** Patch unifié -> markup Pango (ajouts en vert, suppressions en rouge, entêtes atténués). */
function patchMarkup(patch: string): string {
  const text = patch.length > MAX_PATCH ? `${patch.slice(0, MAX_PATCH)}\n… (tronqué)` : patch;
  return text
    .split('\n')
    .filter((l) => !l.startsWith('Index:') && !/^={5,}/u.test(l))
    .map((l) => {
      const e = esc(l);
      if (l.startsWith('+++') || l.startsWith('---')) return `<span alpha="60%">${e}</span>`;
      if (l.startsWith('@@')) return `<span foreground="#1c71d8">${e}</span>`;
      if (l.startsWith('+')) return `<span foreground="#26a269">${e}</span>`;
      if (l.startsWith('-')) return `<span foreground="#c01c28">${e}</span>`;
      return e;
    })
    .join('\n');
}

const STATUS_ICON: Readonly<Record<string, string>> = {
  added: 'list-add-symbolic',
  deleted: 'list-remove-symbolic',
};

function FileRow({ file }: { file: FileDiff }): JSX.Element {
  return (
    <Adw.ExpanderRow title={esc(file.path)} subtitle={`<span foreground="#26a269">+${file.additions}</span>  <span foreground="#c01c28">−${file.deletions}</span>`}>
      <Gtk.Image $type="prefix" iconName={STATUS_ICON[file.status ?? ''] ?? 'document-edit-symbolic'} />
      <Gtk.Label
        xalign={0}
        selectable
        wrap
        wrapMode={Pango.WrapMode.CHAR}
        cssClasses={['monospace', 'diff']}
        $={(self: Gtk.Label) => {
          try {
            self.set_markup(patchMarkup(file.patch ?? ''));
          } catch {
            self.set_text(file.patch ?? '');
          }
        }}
      />
    </Adw.ExpanderRow>
  );
}

export function openDiffDialog(parent: Gtk.Widget, title: string, load: () => Promise<FileDiff[]>): void {
  const stack = new Gtk.Stack();
  stack.add_named(new Adw.Spinner({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, widthRequest: 32, heightRequest: 32 }), 'loading');
  const dialog = new Adw.Dialog({ title, contentWidth: 900, contentHeight: 700 });
  const view = new Adw.ToolbarView({ content: stack });
  view.add_top_bar(new Adw.HeaderBar());
  dialog.child = view;
  dialog.present(parent);

  const show = async (): Promise<void> => {
    let content: JSX.Element;
    try {
      const files = await load();
      content =
        files.length === 0 ? (
          <Adw.StatusPage iconName="document-edit-symbolic" title="Aucun fichier modifié" />
        ) : (
          <Gtk.ScrolledWindow hscrollbarPolicy={Gtk.PolicyType.NEVER}>
            <Adw.Clamp maximumSize={1100} marginTop={12} marginBottom={12} marginStart={12} marginEnd={12}>
              <Gtk.ListBox cssClasses={['boxed-list']} selectionMode={Gtk.SelectionMode.NONE} valign={Gtk.Align.START}>
                {files.map((f) => (
                  <FileRow file={f} />
                ))}
              </Gtk.ListBox>
            </Adw.Clamp>
          </Gtk.ScrolledWindow>
        );
    } catch (e) {
      content = <Adw.StatusPage iconName="dialog-error-symbolic" title="Impossible de charger les modifications" description={esc(String(e))} />;
    }
    if (content instanceof Gtk.Widget) {
      stack.add_named(content, 'content');
      stack.visibleChildName = 'content';
    }
  };
  void show();
}
