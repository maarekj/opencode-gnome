// Liens web épinglés d'un projet (barre des terminaux, à droite) : une pastille par lien, bouton
// divisé du navigateur (navigateur du projet ; flèche : autres navigateurs) et bouton « + ».
// Les variables de l'adresse ($PORT_WEB…) sont résolues avec le direnv du dossier affiché :
// celui de la session (son worktree) sur une session, celui du projet sur sa page.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { onCleanup, type Accessor } from 'gnim';
import { expandVariables, variablesOf, withScheme } from '../shared/direnv.ts';
import { intercepted } from '../shared/sandbox.ts';
import { errorMessage } from '../shared/errors.ts';
import type { ProjectLink, Settings } from '../shared/settings.ts';
import { attachContextMenu, hosted, labelMenuButton, type MenuHost, type MenuItem } from './ContextMenu.ts';
import { currentFolder, folderChooser } from './FolderChoice.ts';

export interface Browser {
  readonly id: string;
  readonly name: string;
  readonly icon: Gio.Icon | null;
  readonly app: Gio.AppInfo;
}

let browsersCache: Browser[] | null = null;
let monitor: Gio.AppInfoMonitor | null = null;

/** Navigateurs installés (applications qui ouvrent les liens http), navigateur par défaut en tête. */
export function installedBrowsers(): Browser[] {
  if (monitor === null) {
    monitor = Gio.AppInfoMonitor.get();
    monitor.connect('changed', () => {
      browsersCache = null;
    });
  }
  if (browsersCache !== null) return browsersCache;
  const def = Gio.AppInfo.get_default_for_uri_scheme('https')?.get_id() ?? null;
  const seen = new Set<string>();
  const list: Browser[] = [];
  for (const app of Gio.AppInfo.get_recommended_for_type('x-scheme-handler/https')) {
    const id = app.get_id();
    if (id === null || seen.has(id) || !app.should_show()) continue;
    seen.add(id);
    list.push({ id, name: app.get_display_name() ?? app.get_name() ?? id, icon: app.get_icon(), app });
  }
  browsersCache = list.toSorted((a, b) => (a.id === def ? -1 : b.id === def ? 1 : a.name.localeCompare(b.name)));
  return browsersCache;
}

/** Navigateur du projet, sinon celui par défaut du système. */
export function browserFor(settings: Settings, project: string): Browser | null {
  const browsers = installedBrowsers();
  const own = settings.data.peek().browsers[project];
  return browsers.find((b) => b.id === own) ?? browsers[0] ?? null;
}


export interface LinkContext {
  readonly settings: Settings;
  readonly toast: (message: string) => void;
}

/** Ouvre un lien : variables résolues dans `dir`, puis navigateur choisi. */
export async function openLink(link: ProjectLink, dir: string, browser: Browser | null): Promise<void> {
  const url = withScheme(await expandVariables(link.url.trim(), dir));
  if (intercepted('LIEN', `${browser?.id ?? 'défaut'} ${url}`)) return;
  if (browser === null) Gio.AppInfo.launch_default_for_uri(url, null);
  else browser.app.launch_uris([url], null);
}

const nameFromUrl = (url: string): string => url.replace(/^[a-z]+:\/\//iu, '').replace(/\/$/u, '').slice(0, 30) || 'Lien';

/** Dialogue d'ajout (`current` absent) ou de modification d'un lien ; `folder` : comme askTerminal. */
export function askLink(parent: Gtk.Widget, project: string, dir: string, ctx: LinkContext, current?: ProjectLink, folder: string | null = null): void {
  const name = new Adw.EntryRow({ title: 'Nom (vide : déduit de l’adresse)', text: current?.name ?? '' });
  const url = new Adw.EntryRow({ title: 'Adresse (ex. localhost:$PORT_WEB/admin)', text: current?.url ?? '' });
  const preview = new Adw.ActionRow({ title: 'Ouvrira', subtitle: '', cssClasses: ['property'] });
  const group = new Adw.PreferencesGroup();
  for (const r of [name, url, preview]) group.add(r);
  const place = folderChooser(ctx.settings, project, current === undefined ? folder : currentFolder(ctx.settings, project, `link:${current.id}`));
  if (place.row !== null) group.add(place.row);
  const dialog = new Adw.AlertDialog({
    heading: current === undefined ? 'Nouveau lien' : 'Modifier le lien',
    body: 'Variables possibles dans l’adresse ($PORT_WEB, ${HOST}…) : lues dans le direnv du dossier, donc différentes d’un worktree à l’autre.',
    extraChild: group,
    defaultResponse: 'save',
    closeResponse: 'cancel',
  });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('save', current === undefined ? 'Ajouter' : 'Enregistrer');
  dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
  let seq = 0;
  let timer = 0;
  const update = (): void => {
    const text = url.text.trim();
    dialog.set_response_enabled('save', text !== '');
    preview.visible = text !== '';
    // aperçu après une courte pause de frappe : un seul appel à direnv
    if (timer !== 0) GLib.source_remove(timer);
    timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
      timer = 0;
      resolvePreview(text);
      return GLib.SOURCE_REMOVE;
    });
  };
  const resolvePreview = (text: string): void => {
    const n = (seq += 1);
    expandVariables(text, dir).then(
      (v) => {
        if (n !== seq) return null;
        preview.subtitle = GLib.markup_escape_text(withScheme(v), -1);
        preview.remove_css_class('error');
        return null;
      },
      (e: unknown) => {
        if (n !== seq) return null;
        preview.subtitle = GLib.markup_escape_text(errorMessage(e), -1);
        preview.add_css_class('error');
        return null;
      },
    );
  };
  url.connect('changed', update);
  update();
  dialog.connect('closed', () => {
    if (timer !== 0) GLib.source_remove(timer);
    timer = 0;
  });
  dialog.connect('response', (_d: Adw.AlertDialog, response: string) => {
    const text = url.text.trim();
    if (response !== 'save' || text === '') return;
    const taken = new Set((ctx.settings.data.peek().links[project] ?? []).map((l) => l.id));
    let id = current?.id ?? `l${Date.now().toString(36)}`;
    while (!taken.has(current?.id ?? '') && taken.has(id)) id += 'x';
    ctx.settings.saveLink(project, { id, name: name.text.trim() === '' ? nameFromUrl(text) : name.text.trim(), url: text }, place.value());
  });
  dialog.present(parent);
  (current === undefined ? url : name).grab_focus();
}

function askRemove(parent: Gtk.Widget, project: string, link: ProjectLink, ctx: LinkContext): void {
  const dialog = new Adw.AlertDialog({ heading: 'Supprimer le lien ?', body: `« ${link.name} » sera retiré du projet.`, defaultResponse: 'cancel', closeResponse: 'cancel' });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('delete', 'Supprimer');
  dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
  dialog.connect('response', (_d: Adw.AlertDialog, r: string) => {
    if (r === 'delete') ctx.settings.removeLink(project, link.id);
  });
  dialog.present(parent);
}

export function LinkPill({ link, project, dir, ctx, extra, host }: { link: ProjectLink; project: string; dir: () => string; ctx: LinkContext; extra?: () => readonly (readonly MenuItem[])[]; host?: MenuHost }): Gtk.Widget {
  const open = (browser: Browser | null): void => {
    openLink(link, dir(), browser).catch((e: unknown) => ctx.toast(`${link.name} : ${errorMessage(e)}`));
  };
  const vars = variablesOf(link.url);
  const button = new Gtk.Button({
    cssClasses: ['terminal-pill', 'link-pill'],
    tooltipText: `${link.url}${vars.length === 0 ? '' : '\nVariables lues dans le direnv du dossier'}`,
  });
  const box = new Gtk.Box({ spacing: 6 });
  box.append(new Gtk.Image({ iconName: 'web-browser-symbolic', pixelSize: 14 }));
  box.append(new Gtk.Label({ label: link.name }));
  button.child = box;
  button.connect('clicked', () => open(browserFor(ctx.settings, project)));
  const anchor = host?.anchor ?? button;
  attachContextMenu(button, () => hosted(host, [
    [
      { label: 'Ouvrir', activate: () => open(browserFor(ctx.settings, project)) },
      ...installedBrowsers().map((b) => ({ label: `Ouvrir dans ${b.name}`, activate: () => open(b) })),
    ],
    [
      {
        label: 'Copier l’adresse',
        activate: () => {
          expandVariables(link.url.trim(), dir())
            .then((v) => {
              button.get_clipboard().set(withScheme(v));
              return null;
            })
            .catch((e: unknown) => ctx.toast(`${link.name} : ${errorMessage(e)}`));
        },
      },
      { label: 'Modifier…', activate: () => askLink(anchor, project, dir(), ctx, link) },
      { label: 'Supprimer…', activate: () => askRemove(anchor, project, link, ctx) },
    ],
    ...(extra?.() ?? []),
  ]));
  return button;
}

/** Bouton divisé du navigateur du projet : icône du navigateur ; flèche : choix pour ce projet. */
export function BrowserButton({ project, ctx }: { project: Accessor<string | null>; ctx: LinkContext }): Gtk.Widget {
  const button = new Adw.SplitButton({ valign: Gtk.Align.CENTER, cssClasses: ['flat', 'link-browser'] });
  const group = new Gio.SimpleActionGroup();
  button.insert_action_group('browser', group);
  const choose = new Gio.SimpleAction({ name: 'choose', parameterType: new GLib.VariantType('s') });
  choose.connect('activate', (_a: Gio.SimpleAction, p: GLib.Variant | null) => {
    const path = project.peek();
    const id = p?.get_string()[0];
    if (path !== null && id !== undefined) ctx.settings.setProjectBrowser(path, id === '' ? undefined : id);
  });
  group.add_action(choose);
  // le clic principal ne fait rien d'autre qu'ouvrir le menu (le choix porte sur tous les liens)
  button.connect('clicked', () => button.popup());
  let last = '';
  const update = (): void => {
    const path = project.peek();
    const own = path === null ? undefined : ctx.settings.data.peek().browsers[path];
    const key = `${path ?? ''}|${own ?? ''}`;
    if (key === last) return;
    last = key;
    const browsers = installedBrowsers();
    const current = path === null ? null : browserFor(ctx.settings, path);
    button.child = current?.icon === null || current === null ? new Gtk.Image({ iconName: 'web-browser-symbolic' }) : new Gtk.Image({ gicon: current.icon, pixelSize: 16 });
    button.tooltipText = current === null ? 'Navigateur' : `Liens ouverts dans ${current.name}`;
    const menu = new Gio.Menu();
    const pick = new Gio.Menu();
    for (const b of browsers) {
      const item = Gio.MenuItem.new(`${b.id === own ? '✓ ' : ''}${b.name}`, null);
      item.set_action_and_target_value('browser.choose', GLib.Variant.new_string(b.id));
      pick.append_item(item);
    }
    const def = Gio.MenuItem.new(`${own === undefined ? '✓ ' : ''}Navigateur par défaut`, null);
    def.set_action_and_target_value('browser.choose', GLib.Variant.new_string(''));
    pick.append_item(def);
    menu.append_section('Navigateur de ce projet', pick);
    button.menuModel = menu;
    labelMenuButton(button);
  };
  update();
  onCleanup(project.subscribe(update));
  onCleanup(ctx.settings.data.subscribe(update));
  return button;
}
