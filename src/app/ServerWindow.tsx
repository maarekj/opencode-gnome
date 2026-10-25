// Fenêtre « Serveur opencode » : état du serveur partagé (service systemd), redémarrage, journal,
// et accès depuis le réseau (écoute sur toutes les interfaces, mot de passe, adresses avec QR code).
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import qrGenerator from 'qrcode-generator';
import { errorMessage } from '../shared/errors.ts';
import { esc, fmtDuration, fmtFullDate } from '../shared/format.ts';
import {
  controlServer,
  listeningOnNetwork,
  networkAddresses,
  PASSWORD_FORBIDDEN,
  portOf,
  randomPassword,
  readServerAccess,
  serverEnvPath,
  serverJournal,
  serverUnit,
  unitState,
  writeServerAccess,
  type ServerAddress,
} from '../shared/server.ts';
import type { Store } from '../shared/store.ts';

/** QR code d'un texte, dessiné en modules noirs sur fond blanc (lisible quel que soit le thème). */
function qrWidget(text: string, size = 180): Gtk.Widget {
  const qr = qrGenerator(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const area = new Gtk.DrawingArea({ contentWidth: size, contentHeight: size, halign: Gtk.Align.CENTER, tooltipText: text });
  area.set_draw_func((_a: Gtk.DrawingArea, cr, w: number, h: number) => {
    const quiet = 2;
    const cell = Math.floor(Math.min(w, h) / (n + quiet * 2));
    const offset = (Math.min(w, h) - cell * n) / 2;
    cr.setSourceRGB(1, 1, 1);
    cr.rectangle(0, 0, w, h);
    cr.fill();
    cr.setSourceRGB(0, 0, 0);
    for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) if (qr.isDark(y, x)) cr.rectangle(offset + x * cell, offset + y * cell, cell, cell);
    cr.fill();
  });
  return area;
}

function copy(widget: Gtk.Widget, text: string): void {
  widget.get_clipboard().set(text);
}

const STATE_LABEL: Readonly<Record<string, string>> = {
  active: 'En marche',
  inactive: 'Arrêté',
  failed: 'En échec',
  activating: 'Démarrage…',
  deactivating: 'Arrêt…',
  reloading: 'Rechargement…',
};

let current: Adw.Window | null = null;

export function openServerWindow(parent: Gtk.Widget, store: Store): void {
  if (current !== null) {
    current.present();
    return;
  }
  const root = parent.get_root();
  const app = root instanceof Gtk.Window ? root.application : null;
  const win = new Adw.Window({ title: 'Serveur opencode', defaultWidth: 760, defaultHeight: 820, ...(app === null ? {} : { application: app }) });
  current = win;
  const overlay = new Adw.ToastOverlay();
  const toast = (m: string): void => overlay.add_toast(new Adw.Toast({ title: esc(m), timeout: 4 }));

  // ---------------------------------------------------------------- état
  const stateRow = new Adw.ActionRow({ title: 'État', subtitle: '…', cssClasses: ['property'] });
  const stateIcon = new Gtk.Image({ iconName: 'emblem-default-symbolic' });
  stateRow.add_prefix(stateIcon);
  const versionRow = new Adw.ActionRow({ title: 'Version', subtitle: '…', cssClasses: ['property'] });
  const urlRow = new Adw.ActionRow({ title: 'Adresse utilisée par l’application', subtitle: esc(store.client.url), cssClasses: ['property'], subtitleSelectable: true });
  const sessionsRow = new Adw.ActionRow({ title: 'Sessions en cours', subtitle: '…', cssClasses: ['property'] });
  const unitRow = new Adw.ActionRow({ title: 'Service', subtitle: esc(`${serverUnit()} (systemd utilisateur)`), cssClasses: ['property'], subtitleSelectable: true });
  const start = new Gtk.Button({ label: 'Démarrer', valign: Gtk.Align.CENTER });
  const stop = new Gtk.Button({ label: 'Arrêter', valign: Gtk.Align.CENTER });
  const restart = new Gtk.Button({ label: 'Redémarrer', valign: Gtk.Align.CENTER, cssClasses: ['suggested-action'] });
  const buttons = new Gtk.Box({ spacing: 6 });
  for (const b of [start, stop, restart]) buttons.append(b);
  const stateGroup = new Adw.PreferencesGroup({ title: 'État' });
  stateGroup.headerSuffix = buttons;
  for (const r of [stateRow, versionRow, urlRow, sessionsRow, unitRow]) stateGroup.add(r);

  // ---------------------------------------------------------------- accès réseau
  const access = readServerAccess();
  const network = new Adw.SwitchRow({
    title: 'Accès depuis le réseau',
    subtitle: 'Le serveur écoute sur toutes les interfaces (téléphone, autre ordinateur). Il peut lire et modifier tes fichiers et lancer des commandes : protège-le par un mot de passe.',
    active: access.network,
  });
  const password = new Adw.PasswordEntryRow({ title: 'Mot de passe (utilisateur « opencode »)', text: access.password });
  const generate = new Gtk.Button({ iconName: 'view-refresh-symbolic', tooltipText: 'Proposer un mot de passe', valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
  generate.connect('clicked', () => {
    password.text = randomPassword();
  });
  const copyPw = new Gtk.Button({ iconName: 'edit-copy-symbolic', tooltipText: 'Copier le mot de passe', valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
  copyPw.connect('clicked', () => {
    copy(copyPw, password.text);
    toast('Mot de passe copié');
  });
  password.add_suffix(generate);
  password.add_suffix(copyPw);
  const apply = new Gtk.Button({ label: 'Appliquer et redémarrer', valign: Gtk.Align.CENTER, cssClasses: ['suggested-action'], sensitive: false });
  const accessGroup = new Adw.PreferencesGroup({
    title: 'Accès depuis d’autres appareils',
    description: `Réglages enregistrés dans ${serverEnvPath().replace(GLib.get_home_dir(), '~')} ; appliqués au redémarrage du serveur.`,
  });
  accessGroup.headerSuffix = apply;
  accessGroup.add(network);
  accessGroup.add(password);
  const dirty = (): boolean => network.active !== access.network || password.text !== access.password;
  const updateApply = (): void => {
    const pwOk = !PASSWORD_FORBIDDEN.test(password.text);
    password.title = pwOk ? 'Mot de passe (utilisateur « opencode »)' : 'Mot de passe : espaces, guillemets, \\, $ et ` interdits';
    if (pwOk) password.remove_css_class('error');
    else password.add_css_class('error');
    apply.sensitive = dirty() && pwOk;
  };
  network.connect('notify::active', updateApply);
  password.connect('changed', updateApply);

  // adresses à configurer sur l'autre appareil
  const addrGroup = new Adw.PreferencesGroup({ title: 'Adresses de connexion' });
  const addrRows: Gtk.Widget[] = [];
  let addrKey = '';
  const showAddresses = (list: readonly ServerAddress[], listening: boolean): void => {
    // inchangé : lignes conservées (QR code déplié)
    const key = JSON.stringify([listening, readServerAccess().password === '', list]);
    if (key === addrKey) return;
    addrKey = key;
    for (const r of addrRows.splice(0)) addrGroup.remove(r);
    addrGroup.description = listening
      ? `Identifiant : opencode${readServerAccess().password === '' ? ' — aucun mot de passe : n’importe qui sur le réseau peut utiliser le serveur.' : ', avec le mot de passe ci-dessus.'}`
      : 'Le serveur n’écoute que sur cet ordinateur (127.0.0.1) : active l’accès depuis le réseau puis redémarre.';
    if (!listening) return;
    if (list.length === 0) {
      const none = new Adw.ActionRow({ title: 'Aucune adresse réseau trouvée', cssClasses: ['dim-label'] });
      addrGroup.add(none);
      addrRows.push(none);
    }
    for (const a of list) {
      const row = new Adw.ExpanderRow({ title: esc(a.url), subtitle: esc(a.label), titleSelectable: true });
      const copyBtn = new Gtk.Button({ iconName: 'edit-copy-symbolic', tooltipText: 'Copier l’adresse', valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
      copyBtn.connect('clicked', () => {
        copy(copyBtn, a.url);
        toast('Adresse copiée');
      });
      row.add_suffix(copyBtn);
      const qrBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, marginTop: 12, marginBottom: 12 });
      qrBox.append(qrWidget(a.url));
      qrBox.append(new Gtk.Label({ label: 'Scanne ce code avec le téléphone', cssClasses: ['dim-label', 'caption'] }));
      row.add_row(qrBox);
      addrGroup.add(row);
      addrRows.push(row);
    }
  };

  // ---------------------------------------------------------------- journal
  const journal = new Gtk.TextView({ editable: false, cursorVisible: false, monospace: true, wrapMode: Gtk.WrapMode.WORD_CHAR, topMargin: 8, bottomMargin: 8, leftMargin: 10, rightMargin: 10, cssClasses: ['card', 'monospace', 'caption'] });
  const journalScroll = new Gtk.ScrolledWindow({ child: journal, minContentHeight: 220, maxContentHeight: 400, propagateNaturalHeight: true });
  const copyJournal = new Gtk.Button({ iconName: 'edit-copy-symbolic', tooltipText: 'Copier le journal', cssClasses: ['flat'], valign: Gtk.Align.CENTER });
  copyJournal.connect('clicked', () => {
    copy(copyJournal, journal.buffer.text);
    toast('Journal copié');
  });
  const journalGroup = new Adw.PreferencesGroup({ title: 'Journal', description: 'Dernières lignes (journalctl --user -u …)' });
  journalGroup.headerSuffix = copyJournal;
  journalGroup.add(journalScroll);

  const page = new Adw.PreferencesPage();
  for (const g of [stateGroup, accessGroup, addrGroup, journalGroup]) page.add(g);
  const header = new Adw.HeaderBar();
  const refreshBtn = new Gtk.Button({ iconName: 'view-refresh-symbolic', tooltipText: 'Rafraîchir (F5)' });
  header.pack_start(refreshBtn);
  const view = new Adw.ToolbarView({ content: page });
  view.add_top_bar(header);
  overlay.child = view;
  win.content = overlay;

  // ---------------------------------------------------------------- chargement
  let seq = 0;
  const refresh = async (): Promise<void> => {
    const n = (seq += 1);
    const st = await unitState();
    const port = portOf(st.command);
    const [health, statuses, journalText, addrs, listening] = await Promise.all([
      store.client.health().catch(() => null),
      store.client.statuses().catch(() => null),
      serverJournal(),
      networkAddresses(port),
      listeningOnNetwork(port),
    ]);
    if (n !== seq) return;
    const running = st.active === 'active';
    stateIcon.iconName = running ? (health === null ? 'dialog-warning-symbolic' : 'object-select-symbolic') : 'media-playback-stop-symbolic';
    stateIcon.cssClasses = [running ? (health === null ? 'warning' : 'success') : st.active === 'failed' ? 'error' : 'dim-label'];
    const since = st.since === null ? '' : ` depuis ${fmtDuration(Date.now() - st.since)}`;
    stateRow.subtitle = esc(
      st.installed
        ? `${STATE_LABEL[st.active] ?? st.active}${since}${st.pid === null ? '' : ` · PID ${st.pid}`}${running && health === null ? ' · ne répond pas' : ''}`
        : 'Service non installé (node scripts/install.ts dans opencode-gnome)',
    );
    stateRow.tooltipText = st.since === null ? '' : `Démarré le ${fmtFullDate(st.since)}\n${st.command}`;
    versionRow.subtitle = esc(health?.version ?? '—');
    const busy = statuses === null ? null : Object.values(statuses).filter((s) => s.type !== 'idle').length;
    sessionsRow.subtitle = busy === null ? '—' : String(busy);
    start.visible = !running;
    stop.visible = running;
    restart.sensitive = st.installed;
    const buffer = journal.buffer;
    buffer.text = journalText === '' ? 'Journal vide.' : journalText;
    // fin du journal visible
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      journal.scroll_to_iter(buffer.get_end_iter(), 0, false, 0, 1);
      return GLib.SOURCE_REMOVE;
    });
    showAddresses(addrs, listening);
    lastBusy = busy ?? 0;
  };
  const reload = (): void => {
    refresh().catch((e: unknown) => toast(errorMessage(e)));
  };
  let lastBusy = 0;

  /** Action sur le service ; confirmation si des sessions tournent (elles seraient interrompues). */
  const control = (action: 'start' | 'stop' | 'restart', then?: () => void): void => {
    const go = (): void => {
      controlServer(action)
        .then(() => {
          then?.();
          toast(action === 'stop' ? 'Serveur arrêté' : action === 'start' ? 'Serveur démarré' : 'Serveur redémarré');
          // le temps que le serveur réponde
          GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            reload();
            return GLib.SOURCE_REMOVE;
          });
          return null;
        })
        .catch((e: unknown) => toast(errorMessage(e)));
    };
    if (action === 'start' || lastBusy === 0) {
      go();
      return;
    }
    const dialog = new Adw.AlertDialog({
      heading: action === 'stop' ? 'Arrêter le serveur ?' : 'Redémarrer le serveur ?',
      body: `${lastBusy} session${lastBusy > 1 ? 's' : ''} en cours ser${lastBusy > 1 ? 'ont' : 'a'} interrompue${lastBusy > 1 ? 's' : ''}.`,
      defaultResponse: 'cancel',
      closeResponse: 'cancel',
    });
    dialog.add_response('cancel', 'Annuler');
    dialog.add_response('go', action === 'stop' ? 'Arrêter' : 'Redémarrer');
    dialog.set_response_appearance('go', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.connect('response', (_d: Adw.AlertDialog, r: string) => {
      if (r === 'go') go();
    });
    dialog.present(win);
  };
  start.connect('clicked', () => control('start'));
  stop.connect('clicked', () => control('stop'));
  restart.connect('clicked', () => control('restart'));
  apply.connect('clicked', () => {
    try {
      writeServerAccess({ network: network.active, password: password.text });
    } catch (e) {
      toast(errorMessage(e));
      return;
    }
    Object.assign(access, { network: network.active, password: password.text });
    updateApply();
    // l'application envoie désormais le nouveau mot de passe (le flux d'événements se reconnecte)
    control('restart', () => store.client.setPassword(password.text));
  });
  refreshBtn.connect('clicked', reload);
  const keys = new Gtk.EventControllerKey();
  keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number) => {
    if (keyval === Gdk.KEY_Escape) win.close();
    else if (keyval === Gdk.KEY_F5) reload();
    else return false;
    return true;
  });
  win.add_controller(keys);
  const timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 5, () => {
    reload();
    return GLib.SOURCE_CONTINUE;
  });
  win.connect('close-request', () => {
    GLib.source_remove(timer);
    current = null;
    return false;
  });
  updateApply();
  reload();
  win.present();
}
