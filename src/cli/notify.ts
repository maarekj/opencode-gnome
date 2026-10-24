// Notifications envoyées par un run (hors de l'application) : au nom de l'application
// (org.gtk.Notifications), avec le même identifiant que ses propres notifications de session :
// un clic ouvre la session dans l'app, et une notification de l'app pour la même session est remplacée.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const APP_ID = (): string => GLib.getenv('OPENCODE_GNOME_APP_ID') ?? 'io.github.maarekj.OpencodeGnome';

export interface RunNotification {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly urgent: boolean;
  /** session à ouvrir au clic */
  readonly sessionID?: string;
}

export function notify(n: RunNotification): void {
  if (GLib.getenv('OPENCODE_GNOME_TEST_NOTIFY') !== null) {
    print(`NOTIF ${n.id} | ${n.title} | ${n.body}${n.urgent ? ' | urgente' : ''}`);
    return;
  }
  try {
    const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
    const props: Record<string, GLib.Variant> = {
      title: new GLib.Variant('s', n.title),
      body: new GLib.Variant('s', n.body),
      priority: new GLib.Variant('s', n.urgent ? 'high' : 'normal'),
    };
    if (n.sessionID !== undefined) {
      const target = new GLib.Variant('v', new GLib.Variant('s', n.sessionID));
      props['default-action'] = new GLib.Variant('s', 'app.open-session');
      props['default-action-target'] = target;
      props['buttons'] = new GLib.Variant('aa{sv}', [{ label: new GLib.Variant('s', 'Ouvrir'), action: new GLib.Variant('s', 'app.open-session'), target }]);
    }
    bus.call_sync(
      'org.gtk.Notifications',
      '/org/gtk/Notifications',
      'org.gtk.Notifications',
      'AddNotification',
      new GLib.Variant('(ssa{sv})', [APP_ID(), n.id, props]),
      null,
      Gio.DBusCallFlags.NONE,
      5000,
      null,
    );
  } catch (e) {
    // pas de GNOME Shell : notification simple, sans action
    try {
      Gio.bus_get_sync(Gio.BusType.SESSION, null).call_sync(
        'org.freedesktop.Notifications',
        '/org/freedesktop/Notifications',
        'org.freedesktop.Notifications',
        'Notify',
        new GLib.Variant('(susssasa{sv}i)', ['opencode', 0, APP_ID(), n.title, n.body, [], {}, -1]),
        null,
        Gio.DBusCallFlags.NONE,
        5000,
        null,
      );
    } catch {
      printerr(`notification impossible : ${String(e)}`);
    }
  }
}
