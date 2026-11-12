// Quotas du forfait Claude en bas de la barre latérale (#166) : une jauge par limite, détail en
// infobulle, notification au franchissement de 80 % puis 95 %.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { crossedAlert, resetText, usageLevel, USAGE_INTERVAL_S, type Usage } from '../shared/usage.ts';
import type { TokenStatus } from '../shared/claudeToken.ts';
import { claudeRenewing, claudeToken, claudeUsage, refreshUsage, renewClaudeToken } from '../shared/usageState.ts';

const TEST_NOTIFY = GLib.getenv('OPENCODE_GNOME_TEST_NOTIFY') !== null;

const hhmm = (ms: number): string => GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000)).format('%H:%M') ?? '';

/** Ligne du jeton dans l'infobulle (#167). */
export function tokenLine(t: TokenStatus, now = Date.now()): string {
  const renewed = t.lastSuccess === null ? '' : `, renouvelée à ${hhmm(t.lastSuccess)}`;
  return t.expired ? 'Connexion Claude expirée' : `Connexion Claude : expire ${resetText(new Date(t.expiresAt), new Date(now))}${renewed}`;
}

/** Alerte : jeton expiré, ou dernier renouvellement en échec. */
export const tokenAlert = (t: TokenStatus | null): boolean => t !== null && (t.expired || t.error !== null);

export function usageTooltip(u: Usage, token: TokenStatus | null = null): string {
  const head = [u.plan ?? 'Forfait Claude', u.account].filter((s) => s !== null).join(' · ');
  const lines = u.limits.map((l) => {
    const reset = resetText(l.resetsAt);
    return `${l.label} : ${Math.round(l.percent)} %${reset === '' ? '' : ` — remise à zéro ${reset}`}`;
  });
  const at = GLib.DateTime.new_from_unix_local(Math.floor(u.fetchedAt.getTime() / 1000)).format('%H:%M') ?? '';
  return [head, ...lines, ...(token === null ? [] : [tokenLine(token)]), `Mis à jour à ${at}`].join('\n');
}

/** Barre des quotas : masquée sans forfait Claude connecté. Relue chaque minute, fenêtre active. */
export function usageBar(): Gtk.Widget {
  const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, cssClasses: ['usage-bar'], visible: false });
  // jeton expiré ou non renouvelé : alerte et bouton (les quotas, illisibles, sont alors masqués)
  const alert = new Gtk.Box({ spacing: 8, visible: false, cssClasses: ['usage-alert'] });
  alert.append(new Gtk.Image({ iconName: 'dialog-warning-symbolic', cssClasses: ['usage-critical'] }));
  const alertLabel = new Gtk.Label({ xalign: 0, hexpand: true, wrap: true, cssClasses: ['caption'] });
  alert.append(alertLabel);
  const renew = new Gtk.Button({ label: 'Renouveler', valign: Gtk.Align.CENTER, cssClasses: ['small', 'suggested-action'], tooltipText: 'Renouveler la connexion Claude (claude -p)' });
  renew.connect('clicked', () => void renewClaudeToken());
  alert.append(renew);
  outer.append(alert);
  const box = new Gtk.Box({ spacing: 10, visible: false, hasTooltip: true });
  outer.append(box);
  const renderAlert = (): void => {
    const t = claudeToken.peek();
    alert.visible = tokenAlert(t);
    outer.visible = alert.visible || box.visible;
    if (t === null) return;
    alertLabel.label = t.expired ? 'Connexion Claude expirée : les agents ne peuvent plus utiliser le forfait.' : `Renouvellement du jeton Claude en échec : ${t.error ?? ''}`;
    alertLabel.tooltipText = t.error ?? '';
    const busy = claudeRenewing.peek();
    renew.sensitive = !busy;
    renew.label = busy ? 'Renouvellement…' : 'Renouveler';
  };
  const render = (): void => {
    const u = claudeUsage.peek();
    for (let c = box.get_first_child(); c !== null; c = box.get_first_child()) box.remove(c);
    // la fenêtre de 5 h et les 7 jours ; le détail par modèle reste dans l'infobulle
    const shown = u?.limits.filter((l) => l.key === 'five_hour' || l.key === 'seven_day') ?? [];
    box.visible = u !== null && u.limits.length > 0;
    outer.visible = alert.visible || box.visible;
    if (u === null) return;
    box.tooltipText = usageTooltip(u, claudeToken.peek());
    box.append(new Gtk.Image({ iconName: 'power-profile-performance-symbolic', cssClasses: ['dim-label'] }));
    for (const l of (shown.length > 0 ? shown : u.limits)) {
      const item = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true });
      const row = new Gtk.Box({ spacing: 4 });
      row.append(new Gtk.Label({ label: l.label, xalign: 0, hexpand: true, cssClasses: ['caption'] }));
      row.append(new Gtk.Label({ label: `${Math.round(l.percent)} %`, cssClasses: ['caption', 'numeric', `usage-${usageLevel(l.percent)}`] }));
      item.append(row);
      const bar = new Gtk.LevelBar({ minValue: 0, maxValue: 100, value: l.percent, cssClasses: [`usage-${usageLevel(l.percent)}`] });
      // pas de changement de couleur intégré (offsets par défaut) : la classe s'en charge
      bar.remove_offset_value(Gtk.LEVEL_BAR_OFFSET_LOW);
      bar.remove_offset_value(Gtk.LEVEL_BAR_OFFSET_HIGH);
      bar.remove_offset_value(Gtk.LEVEL_BAR_OFFSET_FULL);
      item.append(bar);
      box.append(item);
    }
  };
  render();
  renderAlert();
  const unsubscribe = [claudeUsage.subscribe(render), claudeToken.subscribe(render), claudeToken.subscribe(renderAlert), claudeRenewing.subscribe(renderAlert)];
  // relecture : à la création (la barre, masquée, n'est pas affichée tant qu'il n'y a rien),
  // au retour sur la fenêtre, puis chaque minute tant qu'elle est active
  void refreshUsage();
  let active: { win: Gtk.Window; id: number } | null = null;
  const tick = (): void => {
    const win = outer.get_root();
    if (win instanceof Gtk.Window && active === null) active = { win, id: win.connect('notify::is-active', tick) };
    if (win instanceof Gtk.Window && win.isActive) void refreshUsage();
  };
  const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT_IDLE, USAGE_INTERVAL_S, () => {
    tick();
    return GLib.SOURCE_CONTINUE;
  });
  // fenêtre connue dès que la barre y est rattachée
  outer.connect('notify::root', tick);
  outer.connect('destroy', () => {
    for (const u of unsubscribe) u();
    GLib.source_remove(timer);
    if (active !== null) active.win.disconnect(active.id);
  });
  return outer;
}

/** Notifications des seuils (une instance pour l'application). */
export function watchUsageAlerts(app: Gio.Application): () => void {
  /** par limite : dernier pourcentage vu et remise à zéro de sa période */
  const seen = new Map<string, { percent: number; reset: number }>();
  let first = true;
  return claudeUsage.subscribe(() => {
    const u = claudeUsage.peek();
    if (u === null) return;
    for (const l of u.limits) {
      const reset = l.resetsAt?.getTime() ?? 0;
      const prev = seen.get(l.key);
      seen.set(l.key, { percent: l.percent, reset });
      // nouvelle période : remise à zéro nettement plus tardive (l'heure renvoyée varie un peu)
      const before = prev === undefined || reset - prev.reset > 10 * 60_000 ? 0 : prev.percent;
      // premier relevé : pas d'alerte pour un seuil déjà dépassé au lancement
      const hit = first ? null : crossedAlert(before, l.percent);
      if (hit === null) continue;
      const when = resetText(l.resetsAt);
      const title = `Forfait Claude : ${Math.round(l.percent)} % de la limite ${l.label}`;
      const body = when === '' ? 'Les agents risquent d’être bloqués.' : `Remise à zéro ${when}.`;
      if (TEST_NOTIFY) console.log(`NOTIF usage-${l.key} | ${title} | ${body}`);
      const n = new Gio.Notification();
      n.set_title(title);
      n.set_body(body);
      n.set_priority(hit >= 95 ? Gio.NotificationPriority.HIGH : Gio.NotificationPriority.NORMAL);
      app.send_notification(`usage-${l.key}`, n);
    }
    first = false;
  });
}
