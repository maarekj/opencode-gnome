// Barre d'un projet (#145) : terminaux persistants et liens épinglés mélangés, dans l'ordre
// choisi (glisser-déposer), rangés ou non dans des dossiers. Un dossier est une pastille qui
// ouvre un menu (ses terminaux et liens) ; un terminal en cours s'y voit sur la pastille.
// À droite : ajout (terminal, lien, dossier) et navigateur du projet.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createComputed, onCleanup, type Accessor } from 'gnim';
import { addFolder, folderId, moveEntry, removeFolder, renameFolder, type FolderEntry, type ItemRef } from '../shared/layout.ts';
import { devenvInstalled } from '../shared/devenv.ts';
import { layoutOf, type ProjectDevenv, type ProjectLink, type ProjectTerminal } from '../shared/settings.ts';
import { zellijInstalled } from '../shared/terminals.ts';
import { attachContextMenu, labelMenuButton, type MenuItem } from './ContextMenu.ts';
import { askDevenv, DevenvPill, devenvMenu, devenvStatusWidget, openDevenvDialog } from './DevenvItem.tsx';
import { foldersOf } from './FolderChoice.ts';
import { keyedBox } from './KeyedBox.ts';
import { askLink, BrowserButton, LinkPill, type LinkContext } from './LinkBar.tsx';
import { dropAtEnd, pillScroller, reorderable } from './PillBar.ts';
import { askTerminal, attachTerminalMenu, TerminalPill, terminalActions, type TerminalContext } from './TerminalBar.tsx';

type Item = { kind: 'terminal'; t: ProjectTerminal; running: boolean } | { kind: 'link'; link: ProjectLink } | { kind: 'devenv'; d: ProjectDevenv };
type Entry = Item | { kind: 'folder'; folder: FolderEntry; items: Item[]; running: number };

const itemKey = (i: Item): string => (i.kind === 'terminal' ? `terminal:${i.t.id}` : i.kind === 'devenv' ? `devenv:${i.d.id}` : `link:${i.link.id}`);
const entryKey = (e: Entry): string => (e.kind === 'folder' ? `folder:${e.folder.folder}` : itemKey(e));

/** Clé de reconstruction : change avec tout ce qui est affiché. */
function signature(e: Entry): string {
  if (e.kind === 'terminal') return `t|${e.t.id}|${e.t.name}|${e.t.command}|${e.t.cwd ?? ''}|${e.running}`;
  if (e.kind === 'link') return `l|${e.link.id}|${e.link.name}|${e.link.url}`;
  if (e.kind === 'devenv') return `d|${e.d.id}|${e.d.name}|${e.d.cwd ?? ''}`;
  return `f|${e.folder.folder}|${e.folder.name}|${e.running}|${e.items.map((i) => signature(i)).join(';')}`;
}

interface BarContext {
  readonly project: string;
  readonly ctx: TerminalContext;
  readonly links: LinkContext;
  readonly dir: () => string;
}

/** Entrées « Déplacer vers » du menu contextuel d'un terminal ou d'un lien. */
function moveMenu(bar: BarContext, key: string, current: string | null): readonly (readonly MenuItem[])[] {
  const move = (folder: string | null): void => bar.ctx.settings.updateLayout(bar.project, (l) => moveEntry(l, key, folder, null));
  const items: MenuItem[] = foldersOf(bar.ctx.settings, bar.project)
    .filter((f) => f.folder !== current)
    .map((f) => ({ label: `Déplacer dans « ${f.name} »`, activate: () => move(f.folder) }));
  if (current !== null) items.push({ label: 'Sortir du dossier', activate: () => move(null) });
  return items.length === 0 ? [] : [items];
}

/** Nom d'un dossier : création (`current` absent) ou renommage. */
function askFolder(parent: Gtk.Widget, bar: BarContext, current?: FolderEntry): void {
  const name = new Adw.EntryRow({ title: 'Nom (ex. worktree 1, utilitaires)', text: current?.name ?? '' });
  const group = new Adw.PreferencesGroup();
  group.add(name);
  const dialog = new Adw.AlertDialog({
    heading: current === undefined ? 'Nouveau dossier' : 'Renommer le dossier',
    body: current === undefined ? 'Un dossier regroupe des terminaux et des liens du projet : glisse-les dessus, ou choisis-le dans leur dialogue.' : '',
    extraChild: group,
    defaultResponse: 'save',
    closeResponse: 'cancel',
  });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('save', current === undefined ? 'Créer' : 'Renommer');
  dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
  const update = (): void => dialog.set_response_enabled('save', name.text.trim() !== '');
  name.connect('changed', update);
  update();
  dialog.connect('response', (_d: Adw.AlertDialog, response: string) => {
    const text = name.text.trim();
    if (response !== 'save' || text === '') return;
    bar.ctx.settings.updateLayout(bar.project, (l) => (current === undefined ? addFolder(l, folderId(l), text) : renameFolder(l, current.folder, text)));
  });
  dialog.present(parent);
  name.grab_focus();
}

function askRemoveFolder(parent: Gtk.Widget, bar: BarContext, folder: FolderEntry): void {
  const dialog = new Adw.AlertDialog({
    heading: 'Supprimer le dossier ?',
    body: `« ${folder.name} » sera retiré ; ses terminaux et liens restent dans la barre.`,
    defaultResponse: 'cancel',
    closeResponse: 'cancel',
  });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('delete', 'Supprimer');
  dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
  dialog.connect('response', (_d: Adw.AlertDialog, r: string) => {
    if (r === 'delete') bar.ctx.settings.updateLayout(bar.project, (l) => removeFolder(l, folder.folder));
  });
  dialog.present(parent);
}

/** Ligne d'un terminal ou d'un lien dans le menu d'un dossier. */
function FolderRow(item: Item, bar: BarContext, folder: FolderEntry, close: () => void, anchor: Gtk.Widget): Gtk.Widget {
  const host = { anchor, close };
  const key = itemKey(item);
  const extra = (): readonly (readonly MenuItem[])[] => moveMenu(bar, key, folder.folder);
  const row = new Gtk.Box({ spacing: 2, cssClasses: ['folder-row'] });
  const main = new Gtk.Button({ hexpand: true, cssClasses: ['flat'] });
  const content = new Gtk.Box({ spacing: 8 });
  main.child = content;
  row.append(main);
  if (item.kind === 'terminal') {
    const { t, running } = item;
    const act = terminalActions(t, bar.project, bar.ctx);
    content.append(new Gtk.Image({ iconName: 'utilities-terminal-symbolic', pixelSize: 14 }));
    content.append(new Gtk.Label({ label: t.name, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END }));
    if (running) content.append(new Gtk.Box({ cssClasses: ['terminal-dot'], valign: Gtk.Align.CENTER, tooltipText: 'En cours' }));
    main.tooltipText = `${t.command === '' ? 'Shell' : t.command}\n${running ? 'En cours : clic pour ouvrir le terminal' : 'Arrêté : clic pour démarrer'}`;
    main.connect('clicked', () => {
      close();
      act.open();
    });
    attachTerminalMenu(main, t, bar.project, bar.ctx, extra, host);
    if (running) {
      const restart = new Gtk.Button({ iconName: 'view-refresh-symbolic', tooltipText: 'Redémarrer', cssClasses: ['flat', 'circular'] });
      restart.connect('clicked', act.restart);
      const stop = new Gtk.Button({ iconName: 'media-playback-stop-symbolic', tooltipText: 'Arrêter', cssClasses: ['flat', 'circular', 'terminal-stop'] });
      stop.connect('clicked', act.stop);
      row.append(restart);
      row.append(stop);
    }
  } else if (item.kind === 'devenv') {
    // panneau des services dans un dialogue (pas de menu dans le menu)
    const { d } = item;
    content.append(new Gtk.Image({ iconName: 'system-run-symbolic', pixelSize: 14 }));
    content.append(new Gtk.Label({ label: d.name, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END }));
    content.append(devenvStatusWidget(d, bar.project, bar.links));
    main.tooltipText = 'Services devenv : état, démarrer, arrêter, logs';
    main.connect('clicked', () => {
      close();
      openDevenvDialog(anchor, d, bar.project, bar.links);
    });
    devenvMenu(main, d, bar.project, bar.links, extra, host);
  } else {
    // même pastille que dans la barre (ouverture, navigateurs, copie, modifier, supprimer)
    const pill = LinkPill({ link: item.link, project: bar.project, dir: bar.dir, ctx: bar.links, extra, host });
    pill.hexpand = true;
    if (pill instanceof Gtk.Button) pill.connect('clicked', close);
    row.remove(main);
    row.append(pill);
  }
  return row;
}

/** Pastille d'un dossier : menu de ses terminaux et liens, terminaux en cours signalés. */
function FolderPill(e: Extract<Entry, { kind: 'folder' }>, bar: BarContext): Gtk.Widget {
  const { folder, items, running } = e;
  const button = new Gtk.MenuButton({
    cssClasses: running > 0 ? ['folder-pill', 'running'] : ['folder-pill'],
    tooltipText: `Dossier « ${folder.name} » : ${items.length} élément${items.length > 1 ? 's' : ''}${running > 0 ? ` — ${running} terminal${running > 1 ? 'aux' : ''} en cours` : ''}`,
    valign: Gtk.Align.CENTER,
  });
  const box = new Gtk.Box({ spacing: 6 });
  box.append(new Gtk.Image({ iconName: 'folder-symbolic', pixelSize: 14 }));
  box.append(new Gtk.Label({ label: folder.name }));
  if (running > 0) {
    box.append(new Gtk.Box({ cssClasses: ['terminal-dot'], valign: Gtk.Align.CENTER }));
    box.append(new Gtk.Label({ label: String(running), cssClasses: ['caption'] }));
  }
  box.append(new Gtk.Image({ iconName: 'pan-down-symbolic', pixelSize: 12 }));
  button.child = box;
  // nom accessible (lecteurs d'écran, tests) : celui de l'infobulle, porté par le bouton interne
  const toggle = button.get_first_child();
  // le bouton à menu lui-même aussi : sinon son nom concatène le contenu du menu
  button.update_property([Gtk.AccessibleProperty.LABEL], [button.tooltipText ?? '']);
  if (toggle !== null) toggle.update_property([Gtk.AccessibleProperty.LABEL], [button.tooltipText ?? folder.name]);

  const popover = new Gtk.Popover({ cssClasses: ['menu'] });
  const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, marginTop: 4, marginBottom: 4, marginStart: 4, marginEnd: 4, widthRequest: 220 });
  const close = (): void => popover.popdown();
  const drag = { active: false };
  const leave = new Gtk.DropControllerMotion();
  leave.connect('leave', () => {
    if (drag.active) close();
  });
  list.add_controller(leave);
  const order = (): string[] => items.map((i) => itemKey(i));
  for (const item of items) {
    const row = FolderRow(item, bar, folder, close, button);
    // réordonner dans le menu (il reste ouvert pendant le glisser) ; le pointeur sort du menu en
    // glissant : il se ferme, pour déposer dans la barre (#146)
    reorderable(row, itemKey(item), {
      vertical: true,
      order,
      move: (key, before) => bar.ctx.settings.updateLayout(bar.project, (l) => moveEntry(l, key, folder.folder, before)),
      dragBegin: () => {
        drag.active = true;
      },
      dragEnd: () => {
        drag.active = false;
      },
    });
    list.append(row);
  }
  if (items.length === 0) list.append(new Gtk.Label({ label: 'Dossier vide : glisse un terminal ou un lien dessus', wrap: true, maxWidthChars: 28, cssClasses: ['dim-label', 'caption'], marginTop: 6, marginBottom: 6 }));
  list.append(new Gtk.Separator({ marginTop: 4, marginBottom: 4 }));
  const adds = new Gtk.Box({ spacing: 4, homogeneous: true });
  if (zellijInstalled()) {
    const addT = new Gtk.Button({ child: new Adw.ButtonContent({ label: 'Terminal', iconName: 'list-add-symbolic' }), tooltipText: `Ajouter un terminal dans « ${folder.name} »`, cssClasses: ['flat'] });
    addT.connect('clicked', () => {
      close();
      askTerminal(button, bar.project, bar.ctx, undefined, folder.folder);
    });
    adds.append(addT);
  }
  const addL = new Gtk.Button({ child: new Adw.ButtonContent({ label: 'Lien', iconName: 'list-add-symbolic' }), tooltipText: `Ajouter un lien dans « ${folder.name} »`, cssClasses: ['flat'] });
  addL.connect('clicked', () => {
    close();
    askLink(button, bar.project, bar.dir(), bar.links, undefined, folder.folder);
  });
  adds.append(addL);
  if (devenvInstalled()) {
    const addD = new Gtk.Button({ child: new Adw.ButtonContent({ label: 'devenv', iconName: 'list-add-symbolic' }), tooltipText: `Ajouter un devenv dans « ${folder.name} »`, cssClasses: ['flat'] });
    addD.connect('clicked', () => {
      close();
      askDevenv(button, bar.project, bar.links, undefined, folder.folder);
    });
    adds.append(addD);
  }
  list.append(adds);
  popover.child = list;
  button.popover = popover;

  attachContextMenu(button, () => [
    [
      { label: 'Renommer…', activate: () => askFolder(button, bar, folder) },
      { label: 'Supprimer le dossier…', activate: () => askRemoveFolder(button, bar, folder) },
    ],
  ]);
  return button;
}

/** Bouton « + » : nouveau terminal, lien ou dossier. */
function AddButton(project: Accessor<string | null>, bar: () => BarContext | null): Gtk.Widget {
  const button = new Gtk.MenuButton({ iconName: 'list-add-symbolic', tooltipText: 'Ajouter un terminal, un lien ou un dossier', valign: Gtk.Align.CENTER, cssClasses: ['flat', 'circular', 'terminal-add'] });
  const group = new Gio.SimpleActionGroup();
  const action = (name: string, run: (b: BarContext) => void): void => {
    const a = new Gio.SimpleAction({ name });
    a.connect('activate', () => {
      const b = bar();
      if (b !== null) run(b);
    });
    group.add_action(a);
  };
  action('terminal', (b) => askTerminal(button, b.project, b.ctx));
  action('link', (b) => askLink(button, b.project, b.dir(), b.links));
  action('folder', (b) => askFolder(button, b));
  action('devenv', (b) => askDevenv(button, b.project, b.links));
  button.insert_action_group('bar', group);
  const menu = new Gio.Menu();
  if (zellijInstalled()) menu.append('Nouveau terminal persistant…', 'bar.terminal');
  menu.append('Nouveau lien…', 'bar.link');
  if (devenvInstalled()) menu.append('Nouveau devenv (services)…', 'bar.devenv');
  menu.append('Nouveau dossier…', 'bar.folder');
  button.menuModel = menu;
  labelMenuButton(button);
  onCleanup(project.subscribe(() => button.popdown()));
  return button;
}

/**
 * Barre du projet `project`. `directory` : dossier dont le direnv résout les variables des liens
 * (dossier de la session, son worktree), par défaut celui du projet.
 */
export function ProjectBar({ project, ctx, directory }: { project: Accessor<string | null>; ctx: TerminalContext; directory?: () => string | null }): JSX.Element {
  const terminalsOn = zellijInstalled();
  const entries = createComputed((): Entry[] => {
    const p = project();
    if (p === null) return [];
    const d = ctx.settings.data();
    const running = ctx.manager.running();
    const terminals = new Map((d.terminals[p] ?? []).map((t) => [t.id, t]));
    const links = new Map((d.links[p] ?? []).map((l) => [l.id, l]));
    const devenvs = new Map((d.devenvs[p] ?? []).map((x) => [x.id, x]));
    const resolve = (r: ItemRef): Item | null => {
      if ('terminal' in r) {
        const t = terminals.get(r.terminal);
        return t === undefined || !terminalsOn ? null : { kind: 'terminal', t, running: running.has(t.id) };
      }
      if ('devenv' in r) {
        const x = devenvs.get(r.devenv);
        return x === undefined ? null : { kind: 'devenv', d: x };
      }
      const link = links.get(r.link);
      return link === undefined ? null : { kind: 'link', link };
    };
    return layoutOf(d, p).flatMap((e): Entry[] => {
      if (!('folder' in e)) {
        const i = resolve(e);
        return i === null ? [] : [i];
      }
      const items = e.items.map((r) => resolve(r)).filter((i) => i !== null);
      return [{ kind: 'folder', folder: e, items, running: items.filter((i) => i.kind === 'terminal' && i.running).length }];
    });
  });
  ctx.manager.watch();
  const links: LinkContext = { settings: ctx.settings, toast: ctx.toast };
  const dir = (): string => directory?.() ?? project.peek() ?? GLib.get_home_dir();
  const barOf = (p: string): BarContext => ({ project: p, ctx, links, dir });
  const current = (): BarContext | null => {
    const p = project.peek();
    return p === null ? null : barOf(p);
  };
  const order = (): string[] => entries.peek().map((e) => entryKey(e));
  const moveTop = (p: string, key: string, before: string | null): void => ctx.settings.updateLayout(p, (l) => moveEntry(l, key, null, before));
  return (
    <Gtk.Box spacing={6} cssClasses={['terminal-bar', 'project-bar']} visible={project((p) => p !== null)}>
      {pillScroller(
        <Gtk.Box
          spacing={6}
          $={(self: Gtk.Box) => {
            dropAtEnd(self, (key) => {
              const p = project.peek();
              if (p !== null) moveTop(p, key, null);
            });
            onCleanup(
              keyedBox(
                self,
                entries,
                (e) => `${project.peek() ?? ''}|${signature(e)}`,
                (e) => {
                  const p = project.peek() ?? '';
                  const bar = barOf(p);
                  const key = entryKey(e);
                  let pill: Gtk.Widget;
                  if (e.kind === 'folder') pill = FolderPill(e, bar);
                  else if (e.kind === 'devenv') pill = DevenvPill({ d: e.d, project: p, ctx: links, extra: () => moveMenu(bar, key, null) });
                  else if (e.kind === 'terminal') pill = TerminalPill({ t: e.t, project: p, running: e.running, ctx, extra: () => moveMenu(bar, key, null) });
                  else pill = LinkPill({ link: e.link, project: p, dir, ctx: links, extra: () => moveMenu(bar, key, null) });
                  reorderable(pill, key, {
                    order,
                    move: (k, before) => moveTop(p, k, before),
                    // dossier : un terminal ou un lien déposé au milieu y est rangé
                    ...(e.kind === 'folder'
                      ? {
                          into: (k: string) => {
                            if (k.startsWith('folder:')) return false;
                            ctx.settings.updateLayout(p, (l) => moveEntry(l, k, e.folder.folder, null));
                            return true;
                          },
                        }
                      : {}),
                  });
                  return pill;
                },
              ),
            );
          }}
        />,
      )}
      {AddButton(project, current)}
      <Gtk.Label label={terminalsOn ? 'Terminaux et liens' : 'Liens'} cssClasses={['dim-label', 'caption']} visible={entries((l) => l.length === 0)} />
      <Gtk.Box hexpand />
      {BrowserButton({ project, ctx: links })}
    </Gtk.Box>
  );
}
