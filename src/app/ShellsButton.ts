// En-tête d'une session : commandes shell en cours lancées par l'agent, notamment en arrière-plan
// (#182). Bouton « N commande(s) en cours » ; popover : commande, durée, sortie en direct, arrêt.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { onCleanup } from 'gnim';
import { errorMessage } from '../shared/errors.ts';
import { fmtDuration } from '../shared/format.ts';
import type { Store } from '../shared/store.ts';
import type { ShellInfo } from '../shared/v2/schemas.ts';

/** sortie gardée à l'écran (fin de la sortie) */
const MAX_OUTPUT = 20_000;
/** relecture de la sortie et des durées, popover ouvert (ms) */
const REFRESH_MS = 1500;

const plural = (n: number): string => `${n} commande${n > 1 ? 's' : ''} en cours`;

/** Ligne d'une commande : commande, durée, arrêt, sortie repliée (relue tant qu'elle est dépliée). */
function shellRow(store: Store, s: ShellInfo, directory: () => string, toast: (m: string) => void): { widget: Gtk.Widget; tick: () => void } {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, cssClasses: ['shell-row'] });
  const head = new Gtk.Box({ spacing: 8 });
  const command = new Gtk.Label({ label: s.command, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END, maxWidthChars: 50, tooltipText: s.command, cssClasses: ['monospace'] });
  const since = new Gtk.Label({ cssClasses: ['dim-label', 'caption'] });
  const stop = new Gtk.Button({ iconName: 'media-playback-stop-symbolic', tooltipText: 'Arrêter la commande', cssClasses: ['flat', 'circular', 'destructive-action'] });
  stop.connect('clicked', () => {
    stop.sensitive = false;
    store.client.v2
      .removeShell(s.id, directory())
      .then(() => {
        store.forgetShell(s.id);
        return null;
      })
      .catch((e: unknown) => {
        stop.sensitive = true;
        toast(`Arrêt impossible : ${errorMessage(e)}`);
      });
  });
  head.append(command);
  head.append(since);
  head.append(stop);
  box.append(head);

  const output = new Gtk.Label({ xalign: 0, yalign: 0, wrap: true, wrapMode: Pango.WrapMode.CHAR, selectable: true, cssClasses: ['monospace', 'caption'] });
  const scrolled = new Gtk.ScrolledWindow({ child: output, minContentHeight: 60, maxContentHeight: 260, propagateNaturalHeight: true, hscrollbarPolicy: Gtk.PolicyType.NEVER });
  const expander = new Gtk.Expander({ label: 'Sortie', child: scrolled });
  box.append(expander);
  let cursor: number | undefined;
  let text = '';
  let loading = false;
  const readOutput = (): void => {
    if (!expander.expanded || loading) return;
    loading = true;
    store.client.v2
      .shellOutput(s.id, directory(), cursor)
      .then((o) => {
        cursor = o.cursor;
        if (o.output === '') return null;
        text = (text + o.output).slice(-MAX_OUTPUT);
        output.label = text;
        // collée en bas : dernière ligne visible
        const adj = scrolled.get_vadjustment();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
          adj.value = adj.upper;
          return GLib.SOURCE_REMOVE;
        });
        return null;
      })
      // sortie illisible (commande terminée entre-temps) : prochain essai
      .catch(() => null)
      .finally(() => {
        loading = false;
      });
  };
  expander.connect('notify::expanded', readOutput);
  const tick = (): void => {
    since.label = `depuis ${fmtDuration(Date.now() - s.time.started)}`;
    readOutput();
  };
  tick();
  return { widget: box, tick };
}

/**
 * Bouton des commandes en cours d'une session (masqué s'il n'y en a pas). Les commandes déjà en
 * cours sont relues à la création, les suivantes arrivent par les événements `shell.*`.
 */
export function shellsButton(store: Store, sessionID: string, directory: () => string, toast: (m: string) => void): Gtk.MenuButton {
  const label = new Gtk.Label();
  const content = new Gtk.Box({ spacing: 6 });
  content.append(new Adw.Spinner());
  content.append(label);
  const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, marginTop: 8, marginBottom: 8, marginStart: 8, marginEnd: 8, widthRequest: 420 });
  const title = new Gtk.Label({ label: "Commandes lancées par l'agent", xalign: 0, cssClasses: ['heading'] });
  const popover = new Gtk.Popover({ child: list });
  const button = new Gtk.MenuButton({ child: content, popover, cssClasses: ['flat', 'shells-button'] });

  let rows: { id: string; tick: () => void }[] = [];
  const shells = (): ShellInfo[] => store.sessionShells(sessionID);
  const rebuild = (): void => {
    for (let c = list.get_first_child(); c !== null; c = list.get_first_child()) list.remove(c);
    list.append(title);
    rows = shells().map((s) => {
      const r = shellRow(store, s, directory, toast);
      list.append(r.widget);
      return { id: s.id, tick: r.tick };
    });
  };
  const update = (): void => {
    const now = shells();
    button.visible = now.length > 0;
    // compact dans l'en-tête : le nombre ; texte complet en infobulle et nom accessible
    label.label = String(now.length);
    button.tooltipText = `${plural(now.length)} (lancées par l'agent, arrière-plan compris)`;
    button.update_property([Gtk.AccessibleProperty.LABEL], [plural(now.length)]);
    if (now.length === 0) popover.popdown();
    // popover ouvert : lignes reconstruites seulement si la liste a changé (sorties dépliées gardées)
    if (popover.visible && (now.length !== rows.length || now.some((s, i) => rows[i]?.id !== s.id))) rebuild();
  };
  popover.connect('notify::visible', () => {
    if (popover.visible) rebuild();
  });
  update();
  onCleanup(store.shells.subscribe(update));
  const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_MS, () => {
    if (popover.visible) for (const r of rows) r.tick();
    return GLib.SOURCE_CONTINUE;
  });
  onCleanup(() => {
    GLib.source_remove(timer);
  });
  store.loadShells(directory()).catch((e: unknown) => console.error(`commandes en cours : ${errorMessage(e)}`));
  return button;
}
