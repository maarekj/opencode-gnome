import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { createRoot } from 'gnim';
import { OpencodeClient } from '../shared/client.ts';
import { serverUrl } from '../shared/config.ts';
import { Settings } from '../shared/settings.ts';
import { Store } from '../shared/store.ts';
import { MainWindow, type WindowApi } from './MainWindow.tsx';
import { openPreferences } from './PreferencesDialog.tsx';
import { STYLESHEET } from './style.ts';

export const APP_ID = 'io.github.maarekj.OpencodeGnome';

const app = new Adw.Application({ applicationId: APP_ID, flags: Gio.ApplicationFlags.DEFAULT_FLAGS });
const store = new Store(new OpencodeClient(serverUrl()));
const settings = new Settings();
let api: WindowApi | null = null;
let size: [number, number] | undefined;

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
  app.activate();
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

/** app.preferences : menu principal, Ctrl+, */
const preferences = new Gio.SimpleAction({ name: 'preferences' });
preferences.connect('activate', () => {
  const win = app.get_active_window();
  if (win !== null) openPreferences(win, settings, store.client.providers(GLib.get_home_dir()));
});
app.add_action(preferences);
app.set_accels_for_action('app.preferences', ['<Control>comma']);

/** app.toggle-tools : afficher / masquer les appels d'outils (Ctrl+Maj+O) */
const toggleTools = new Gio.SimpleAction({ name: 'toggle-tools' });
toggleTools.connect('activate', () => {
  const t0 = Date.now();
  settings.setShowTools(!settings.data.peek().showTools);
  if (GLib.getenv('OPENCODE_GNOME_TIMING') !== null) console.log(`TIMING bascule outils ${Date.now() - t0} ms`);
});
app.add_action(toggleTools);
app.set_accels_for_action('app.toggle-tools', ['<Control><Shift>o']);

// ------------------------------------------------------------------ fenêtre

app.connect('startup', () => {
  const css = new Gtk.CssProvider();
  css.load_from_string(STYLESHEET);
  const display = Gdk.Display.get_default();
  // oxlint-disable-next-line typescript/no-deprecated -- seule API exposée par GJS pour un style global
  if (display !== null) Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
  // taille du texte de la conversation (préférences), appliquée en direct
  const fontCss = new Gtk.CssProvider();
  const applyFont = (): void => {
    fontCss.load_from_string(`.conversation { font-size: ${settings.data.peek().fontScale}%; }`);
  };
  applyFont();
  settings.data.subscribe(applyFont);
  // oxlint-disable-next-line typescript/no-deprecated -- seule API exposée par GJS pour un style global
  if (display !== null) Gtk.StyleContext.add_provider_for_display(display, fontCss, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1);
});

app.connect('activate', () => {
  const existing = app.get_active_window();
  if (existing !== null) {
    existing.present();
    return;
  }
  store.start();
  settings.watch();
  createRoot((dispose) => {
    const win = MainWindow({
      app,
      store,
      settings,
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
