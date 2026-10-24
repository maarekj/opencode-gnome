import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createRoot } from 'gnim';
import { OpencodeClient } from '../shared/client.ts';
import { serverUrl } from '../shared/config.ts';
import { Settings } from '../shared/settings.ts';
import { Store } from '../shared/store.ts';
import { MainWindow, type WindowApi } from './MainWindow.tsx';
import { Notifier } from './Notifier.ts';
import { openPreferences } from './PreferencesDialog.tsx';
import { STYLESHEET } from './style.ts';
import { openTasksWindow, TasksMonitor } from './TasksWindow.tsx';

/** Identifiant D-Bus : distinct pour l'app d'un worktree (lancée en même temps que la principale). */
export const APP_ID = GLib.getenv('OPENCODE_GNOME_APP_ID') ?? 'io.github.maarekj.OpencodeGnome';

const app = new Adw.Application({ applicationId: APP_ID, flags: Gio.ApplicationFlags.DEFAULT_FLAGS });
// icône installée sous l'identifiant de l'application (scripts/install.ts)
Gtk.Window.set_default_icon_name(APP_ID);
const store = new Store(new OpencodeClient(serverUrl()));
const settings = new Settings();
let api: WindowApi | null = null;
/** tâches planifiées : suivi des fichiers (créé au démarrage) */
let tasks: TasksMonitor | null = null;
const tasksMonitor = (): TasksMonitor => (tasks ??= new TasksMonitor());
let notifier: Notifier | null = null;
let size: [number, number] | undefined;

/**
 * Police à chasse fixe de GNOME (`monospace-font-name`, ex. « Adwaita Mono 11 »), appliquée
 * explicitement : la classe `.monospace` seule retombe parfois sur une police proportionnelle.
 */
function monospaceFamily(): string {
  try {
    const source = Gio.SettingsSchemaSource.get_default();
    if ((source?.lookup('org.gnome.desktop.interface', true) ?? null) === null) return 'monospace';
    const name = new Gio.Settings({ schemaId: 'org.gnome.desktop.interface' }).get_string('monospace-font-name');
    return Pango.FontDescription.from_string(name).get_family()?.replaceAll('"', '') ?? 'monospace';
  } catch {
    return 'monospace';
  }
}

// ------------------------------------------------------------------ ligne de commande

app.add_main_option('session', 's'.codePointAt(0) ?? 0, GLib.OptionFlags.NONE, GLib.OptionArg.STRING, 'Ouvre une session', 'ID');
app.add_main_option('size', 0, GLib.OptionFlags.HIDDEN, GLib.OptionArg.STRING, 'Taille de la fenêtre (tests)', 'LxH');

app.connect('handle-local-options', (_app: Adw.Application, options: GLib.VariantDict) => {
  const s = options.lookup_value('size', null)?.get_string()[0];
  const m = s === undefined ? null : /^(\d+)x(\d+)$/u.exec(s);
  if (m !== null) size = [Number(m[1]), Number(m[2])];
  const session = options.lookup_value('session', null)?.get_string()[0];
  if (session === undefined) return -1; // comportement par défaut : activate
  // fonctionne aussi si une instance tourne déjà (l'action est transmise par D-Bus)
  app.register(null);
  app.activate();
  app.activate_action('open-session', new GLib.Variant('s', session));
  return 0;
});

// ------------------------------------------------------------------ actions

/** app.open-session(id) : utilisée par la ligne de commande, et plus tard l'extension / les notifications. */
const openSession = new Gio.SimpleAction({ name: 'open-session', parameterType: new GLib.VariantType('s') });
openSession.connect('activate', (_a: Gio.SimpleAction, param: GLib.Variant | null) => {
  const id = param?.get_string()[0];
  if (id === undefined || id === '') return;
  // fenêtre existante : simple present() (le jeton d'activation reçu avec l'action, ex. clic sur
  // une notification, l'autorise à passer au premier plan) ; sinon activation normale
  const win = app.get_active_window();
  if (win === null) app.activate();
  else win.present();
  notifier?.withdraw(id);
  // la session n'est peut-être pas encore chargée : attendre le premier chargement
  if (store.projects.peek().length > 0 || store.connection.peek().state === 'error') {
    api?.openSession(id);
    return;
  }
  const unsubscribe = store.projects.subscribe(() => {
    unsubscribe();
    api?.openSession(id);
  });
});
app.add_action(openSession);

/** app.reply-permission((session, répertoire, demande, réponse)) : boutons des notifications */
const replyPermission = new Gio.SimpleAction({ name: 'reply-permission', parameterType: new GLib.VariantType('(ssss)') });
replyPermission.connect('activate', (_a: Gio.SimpleAction, param: GLib.Variant | null) => {
  if (param === null) return;
  const [sessionID, directory, requestID, reply] = param.deepUnpack<[string, string, string, string]>();
  if (reply !== 'once' && reply !== 'reject') return;
  notifier?.withdraw(sessionID);
  store.client.replyPermission(requestID, directory, reply).catch((e: unknown) => {
    console.error(e);
  });
});
app.add_action(replyPermission);

/** app.preferences : menu principal, Ctrl+, */
const preferences = new Gio.SimpleAction({ name: 'preferences' });
preferences.connect('activate', () => {
  const win = app.get_active_window();
  if (win !== null) openPreferences(win, settings, store.client.providers(GLib.get_home_dir()));
});
app.add_action(preferences);
app.set_accels_for_action('app.preferences', ['<Control>comma']);

/** app.tasks(page) : fenêtre des tâches planifiées (`tasks` ou `history`) */
const tasksAction = new Gio.SimpleAction({ name: 'tasks', parameterType: new GLib.VariantType('s') });
tasksAction.connect('activate', (_a: Gio.SimpleAction, param: GLib.Variant | null) => {
  const page = param?.get_string()[0] === 'history' ? 'history' : 'tasks';
  const directory = api?.currentDirectory() ?? null;
  openTasksWindow({ app, store, monitor: tasksMonitor(), page, ...(directory === null ? {} : { directory }) });
});
app.add_action(tasksAction);

/** app.toggle-tools : afficher / masquer les appels d'outils (Ctrl+Maj+O) */
const toggleTools = new Gio.SimpleAction({ name: 'toggle-tools' });
toggleTools.connect('activate', () => {
  const t0 = Date.now();
  settings.setShowTools(!settings.data.peek().showTools);
  if (GLib.getenv('OPENCODE_GNOME_TIMING') !== null) console.log(`TIMING bascule outils ${Date.now() - t0} ms`);
});
app.add_action(toggleTools);
app.set_accels_for_action('app.toggle-tools', ['<Control><Shift>o']);

/** app.close-session : ferme la session affichée (Ctrl+W) */
const closeSession = new Gio.SimpleAction({ name: 'close-session' });
closeSession.connect('activate', () => api?.closeCurrent());
app.add_action(closeSession);
app.set_accels_for_action('app.close-session', ['<Control>w']);

// ------------------------------------------------------------------ fenêtre

app.connect('startup', () => {
  const css = new Gtk.CssProvider();
  css.load_from_string(STYLESHEET);
  const display = Gdk.Display.get_default();
  // oxlint-disable-next-line typescript/no-deprecated -- seule API exposée par GJS pour un style global
  if (display !== null) Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
  // taille du texte de la conversation (préférences), appliquée en direct
  const fontCss = new Gtk.CssProvider();
  const mono = monospaceFamily();
  const applyFont = (): void => {
    fontCss.load_from_string(
      `.conversation { font-size: ${settings.data.peek().fontScale}%; }\n.monospace, .diff-view { font-family: "${mono}", "DejaVu Sans Mono", monospace; }`,
    );
  };
  applyFont();
  settings.data.subscribe(applyFont);
  // oxlint-disable-next-line typescript/no-deprecated -- seule API exposée par GJS pour un style global
  if (display !== null) Gtk.StyleContext.add_provider_for_display(display, fontCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1);
});

app.connect('activate', () => {
  // le jeton de lancement hérité de l'environnement ne sert qu'une fois : le garder ferait
  // réutiliser un jeton périmé (refusé par GNOME) quand une action redemande le premier plan
  GLib.unsetenv('XDG_ACTIVATION_TOKEN');
  GLib.unsetenv('DESKTOP_STARTUP_ID');
  const existing = app.get_active_window();
  if (existing !== null) {
    existing.present();
    return;
  }
  store.start();
  settings.watch();
  notifier ??= new Notifier({
    app,
    store,
    settings,
    // la fenêtre doit avoir le focus : sinon la session affichée mérite aussi une notification
    focusedSession: () => (app.get_active_window()?.isActive === true ? (api?.shownSession() ?? null) : null),
  });
  createRoot((dispose) => {
    const win = MainWindow({
      app,
      store,
      settings,
      tasks: tasksMonitor(),
      ...(size === undefined ? {} : { size }),
      ready: (a) => {
        api = a;
      },
    });
    if (!(win instanceof Gtk.Window)) throw new TypeError('fenêtre attendue');
    win.connect('close-request', () => {
      api = null;
      dispose();
      return false;
    });
    win.present();
  });
});
app.connect('shutdown', () => store.stop());

app.runAsync([imports.system.programInvocationName, ...ARGV]).catch((e: unknown) => {
  console.error(e);
});
