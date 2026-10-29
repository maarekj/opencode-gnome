// Élément devenv de la barre du projet (#147) : pastille (état du process manager), panneau des
// services (démarrer, arrêter, redémarrer, logs), fenêtre des logs, dialogues.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createState, type Accessor, type Setter } from 'gnim';
import { devenvAction, devenvDir, devenvLogs, devenvStatus, devenvStream, phaseKind, phaseLabel, refreshedServices, summary, type DevenvProcess, type DevenvState, type PhaseKind } from '../shared/devenv.ts';
import { errorMessage } from '../shared/errors.ts';
import type { ProjectDevenv, Settings } from '../shared/settings.ts';
import { prettyPath } from '../shared/store.ts';
import { attachContextMenu, hosted, type MenuHost, type MenuItem } from './ContextMenu.ts';
import { currentFolder, folderChooser } from './FolderChoice.ts';

export interface DevenvContext {
  readonly settings: Settings;
  readonly toast: (message: string) => void;
}

// ------------------------------------------------------------------ suivi de l'état

/** intervalle de relecture : pastille seule / panneau ouvert (ms) */
const SLOW_MS = 5000;
const FAST_MS = 1500;

interface Watch {
  readonly state: Accessor<DevenvState | null>;
  readonly set: Setter<DevenvState | null>;
  /** abonnés : identifiant -> rapide (panneau ouvert) ou non */
  readonly subs: Map<number, boolean>;
  timer: number;
  ms: number;
  reading: boolean;
}

const watches = new Map<string, Watch>();
let nextSub = 1;

async function read(dir: string, w: Watch): Promise<void> {
  if (w.reading) return;
  w.reading = true;
  try {
    w.set(await devenvStatus(dir));
  } catch (e) {
    w.set({ kind: 'error', message: errorMessage(e) });
  } finally {
    w.reading = false;
  }
}

function schedule(dir: string, w: Watch): void {
  const ms = [...w.subs.values()].some(Boolean) ? FAST_MS : SLOW_MS;
  if (w.timer !== 0 && w.ms === ms) return;
  if (w.timer !== 0) GLib.source_remove(w.timer);
  w.ms = ms;
  w.timer = GLib.timeout_add(GLib.PRIORITY_LOW, ms, () => {
    void read(dir, w);
    return GLib.SOURCE_CONTINUE;
  });
}

/** État du process manager de `dir`, relu tant qu'au moins un abonné le suit (un seul suivi par dossier). */
export function watchDevenv(dir: string): { state: Accessor<DevenvState | null>; fast: (on: boolean) => void; refresh: () => void; release: () => void } {
  let w = watches.get(dir);
  if (w === undefined) {
    const [state, set] = createState<DevenvState | null>(null);
    w = { state, set, subs: new Map(), timer: 0, ms: 0, reading: false };
    watches.set(dir, w);
    void read(dir, w);
  }
  const watch = w;
  const id = nextSub++;
  watch.subs.set(id, false);
  schedule(dir, watch);
  return {
    state: watch.state,
    fast: (on) => {
      if (!watch.subs.has(id)) return;
      watch.subs.set(id, on);
      schedule(dir, watch);
      if (on) void read(dir, watch);
    },
    refresh: () => void read(dir, watch),
    release: () => {
      watch.subs.delete(id);
      if (watch.subs.size > 0) {
        schedule(dir, watch);
        return;
      }
      if (watch.timer !== 0) GLib.source_remove(watch.timer);
      watches.delete(dir);
    },
  };
}

/** Suivi lié à la vie d'un widget : actif tant qu'il est affiché. */
function watchWhileMapped(widget: Gtk.Widget, dir: string, onState: (s: DevenvState | null) => void): { fast: (on: boolean) => void; refresh: () => void } {
  let current: ReturnType<typeof watchDevenv> | null = null;
  let unsubscribe: (() => void) | null = null;
  let fast = false;
  const start = (): void => {
    if (current !== null) return;
    current = watchDevenv(dir);
    current.fast(fast);
    onState(current.state.peek());
    unsubscribe = current.state.subscribe(() => onState(current?.state.peek() ?? null));
  };
  const stop = (): void => {
    unsubscribe?.();
    unsubscribe = null;
    current?.release();
    current = null;
  };
  widget.connect('map', start);
  widget.connect('unmap', stop);
  widget.connect('destroy', stop);
  return {
    fast: (on) => {
      fast = on;
      current?.fast(on);
    },
    refresh: () => current?.refresh(),
  };
}

// ------------------------------------------------------------------ dialogues

/** Dialogue d'ajout (`current` absent) ou de modification d'un élément devenv. */
export function askDevenv(parent: Gtk.Widget, project: string, ctx: DevenvContext, current?: ProjectDevenv, folder: string | null = null): void {
  const name = new Adw.EntryRow({ title: 'Nom', text: current?.name ?? 'devenv' });
  const cwd = new Adw.EntryRow({ title: 'Dossier contenant devenv.nix, relatif au projet (vide : racine)', text: current?.cwd ?? '' });
  const group = new Adw.PreferencesGroup();
  group.add(name);
  group.add(cwd);
  const place = folderChooser(ctx.settings, project, current === undefined ? folder : currentFolder(ctx.settings, project, `devenv:${current.id}`));
  if (place.row !== null) group.add(place.row);
  const dialog = new Adw.AlertDialog({
    heading: current === undefined ? 'Nouveau devenv' : 'Modifier le devenv',
    body: `Services lancés par « devenv up » dans ce dossier (process manager de devenv) : état, démarrer, arrêter, redémarrer, logs. Dossier relatif à ${prettyPath(project)} (chemin absolu ou ~/… aussi acceptés).`,
    extraChild: group,
    defaultResponse: 'save',
    closeResponse: 'cancel',
  });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('save', current === undefined ? 'Ajouter' : 'Enregistrer');
  dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
  const update = (): void => dialog.set_response_enabled('save', name.text.trim() !== '');
  name.connect('changed', update);
  update();
  dialog.connect('response', (_d: Adw.AlertDialog, response: string) => {
    if (response !== 'save' || name.text.trim() === '') return;
    const taken = new Set((ctx.settings.data.peek().devenvs[project] ?? []).map((x) => x.id));
    let id = current?.id ?? `d${Date.now().toString(36)}`;
    if (current === undefined) while (taken.has(id)) id += 'x';
    const dir = cwd.text.trim();
    ctx.settings.saveDevenv(project, { id, name: name.text.trim(), ...(dir === '' ? {} : { cwd: dir }) }, place.value());
  });
  dialog.present(parent);
  name.grab_focus();
}

function askRemoveDevenv(parent: Gtk.Widget, project: string, d: ProjectDevenv, ctx: DevenvContext): void {
  const dialog = new Adw.AlertDialog({
    heading: 'Retirer le devenv ?',
    body: `« ${d.name} » sera retiré de la barre ; ses services ne sont pas arrêtés.`,
    defaultResponse: 'cancel',
    closeResponse: 'cancel',
  });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('delete', 'Retirer');
  dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
  dialog.connect('response', (_d: Adw.AlertDialog, r: string) => {
    if (r === 'delete') ctx.settings.removeDevenv(project, d.id);
  });
  dialog.present(parent);
}

// ------------------------------------------------------------------ logs

const logWindows = new Map<string, Adw.Window>();

/** Fenêtre des logs d'un service, relus toutes les 2 s ; suit la fin tant qu'on y est. */
export function openLogs(parent: Gtk.Widget, dir: string, name: string): void {
  const key = `${dir}\n${name}`;
  const open = logWindows.get(key);
  if (open !== undefined) {
    open.present();
    return;
  }
  const root = parent.get_root();
  const app = root instanceof Gtk.Window ? root.application : null;
  const win = new Adw.Window({ title: `Logs — ${name}`, defaultWidth: 900, defaultHeight: 600, ...(app === null ? {} : { application: app }) });
  logWindows.set(key, win);
  const header = new Adw.HeaderBar({ titleWidget: new Adw.WindowTitle({ title: `Logs — ${name}`, subtitle: prettyPath(dir) }) });
  const copy = new Gtk.Button({ iconName: 'edit-copy-symbolic', tooltipText: 'Copier les logs' });
  header.pack_end(copy);
  const buffer = new Gtk.TextBuffer();
  const view = new Gtk.TextView({ buffer, editable: false, cursorVisible: false, monospace: true, wrapMode: Gtk.WrapMode.WORD_CHAR, topMargin: 8, bottomMargin: 8, leftMargin: 10, rightMargin: 10 });
  const scrolled = new Gtk.ScrolledWindow({ child: view, vexpand: true });
  const toolbar = new Adw.ToolbarView({ content: scrolled });
  toolbar.add_top_bar(header);
  win.content = toolbar;
  copy.connect('clicked', () => copy.get_clipboard().set(buffer.text));
  let last = '';
  let closed = false;
  const load = (): void => {
    devenvLogs(dir, name)
      .then((text) => {
        if (closed || text === last) return null;
        last = text;
        const adj = scrolled.get_vadjustment();
        const atEnd = adj.value + adj.pageSize >= adj.upper - 20;
        buffer.text = text === '' ? '(aucun log)' : text;
        if (atEnd) GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
          adj.value = adj.upper - adj.pageSize;
          return GLib.SOURCE_REMOVE;
        });
        return null;
      })
      .catch((e: unknown) => {
        if (!closed) buffer.text = errorMessage(e);
      });
  };
  load();
  const timer = GLib.timeout_add(GLib.PRIORITY_LOW, 2000, () => {
    load();
    return GLib.SOURCE_CONTINUE;
  });
  const keys = new Gtk.EventControllerKey();
  keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number) => {
    if (keyval !== Gdk.KEY_Escape) return false;
    win.close();
    return true;
  });
  win.add_controller(keys);
  win.connect('close-request', () => {
    closed = true;
    GLib.source_remove(timer);
    logWindows.delete(key);
    return false;
  });
  win.present();
}

// ------------------------------------------------------------------ démarrages en cours

/**
 * Démarrage en cours d'un dossier (`devenv up`, ou d'un service avec le process manager arrêté) :
 * sa sortie, suivie par tous les panneaux du dossier, même ouverts après le lancement.
 */
interface Start {
  readonly what: string;
  readonly lines: string[];
  readonly listeners: Set<() => void>;
}

const starts = new Map<string, Start>();

// oxlint-disable-next-line no-empty-function -- rien à faire après le démarrage
const noop = (): void => {};

const notify = (s: Start): void => {
  for (const l of s.listeners) l();
};

/** Lance un démarrage suivi (un seul à la fois par dossier) ; erreurs en toast. */
function startStreamed(dir: string, what: string, action: 'up' | 'start', name: string | undefined, label: string, ctx: DevenvContext, done: () => void): void {
  if (starts.has(dir)) return;
  const start: Start = { what, lines: [], listeners: new Set() };
  starts.set(dir, start);
  notify(start);
  devenvStream(dir, action, name, (line) => {
    start.lines.push(line);
    if (start.lines.length > 200) start.lines.shift();
    notify(start);
  })
    .catch((e: unknown) => ctx.toast(`${label} : ${errorMessage(e)}`))
    .finally(() => {
      starts.delete(dir);
      notify(start);
      for (const fn of startListeners.get(dir) ?? []) fn();
      done();
    });
  for (const fn of startListeners.get(dir) ?? []) fn();
}

/** abonnés au début / à la fin des démarrages d'un dossier */
const startListeners = new Map<string, Set<() => void>>();

function onStarts(widget: Gtk.Widget, dir: string, fn: () => void): void {
  const add = (): void => {
    const set = startListeners.get(dir) ?? new Set();
    set.add(fn);
    startListeners.set(dir, set);
  };
  const remove = (): void => {
    startListeners.get(dir)?.delete(fn);
  };
  widget.connect('map', add);
  widget.connect('unmap', remove);
  widget.connect('destroy', remove);
}

/** Services connus en cache, mis à jour d'après la liste réelle quand elle change. */
function remember(ctx: DevenvContext, project: string, id: string, state: DevenvState | null): void {
  const current = (ctx.settings.data.peek().devenvs[project] ?? []).find((x) => x.id === id);
  if (current === undefined) return;
  const next = refreshedServices(current.services, state);
  if (next !== null) ctx.settings.setDevenvServices(project, id, next);
}

// ------------------------------------------------------------------ panneau des services

const KIND_CLASS: Readonly<Record<PhaseKind, string>> = { ok: 'devenv-ok', busy: 'devenv-busy', stopped: 'devenv-stopped', failed: 'devenv-failed' };

function dot(kind: PhaseKind): Gtk.Widget {
  return new Gtk.Box({ cssClasses: ['devenv-dot', KIND_CLASS[kind]], valign: Gtk.Align.CENTER });
}

/**
 * Panneau des services de `d` : liste avec état et actions, tout démarrer / tout arrêter.
 * `visible(on)` : à appeler à l'ouverture / fermeture (relecture rapide pendant l'affichage).
 */
export function DevenvPanel(d: ProjectDevenv, project: string, ctx: DevenvContext): { widget: Gtk.Widget; visible: (on: boolean) => void } {
  const dir = devenvDir(d, project);
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, marginTop: 6, marginBottom: 6, marginStart: 6, marginEnd: 6, widthRequest: 380 });
  const head = new Gtk.Box({ spacing: 6 });
  const title = new Gtk.Label({ xalign: 0, hexpand: true, useMarkup: true, ellipsize: Pango.EllipsizeMode.MIDDLE });
  title.set_markup(`<b>${GLib.markup_escape_text(d.name, -1)}</b>  <span alpha="60%">${GLib.markup_escape_text(prettyPath(dir), -1)}</span>`);
  head.append(title);
  const all = new Gtk.Button({ cssClasses: ['flat'] });
  const refresh = new Gtk.Button({ iconName: 'view-refresh-symbolic', tooltipText: 'Relire l’état des services', cssClasses: ['flat', 'circular'] });
  head.append(all);
  head.append(refresh);
  box.append(head);
  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE, cssClasses: ['boxed-list'] });
  const message = new Gtk.Label({ wrap: true, xalign: 0, maxWidthChars: 50, cssClasses: ['dim-label'], marginTop: 6, marginBottom: 6 });
  box.append(list);
  box.append(message);
  // sortie du démarrage en cours (devenv up : évaluation Nix, construction, lancement)
  const progressBuffer = new Gtk.TextBuffer();
  const progressView = new Gtk.TextView({ buffer: progressBuffer, editable: false, cursorVisible: false, monospace: true, wrapMode: Gtk.WrapMode.WORD_CHAR, leftMargin: 6, rightMargin: 6, topMargin: 4, bottomMargin: 4, cssClasses: ['devenv-progress', 'monospace'] });
  const progress = new Gtk.ScrolledWindow({ child: progressView, heightRequest: 160, visible: false, cssClasses: ['card'] });
  box.append(progress);
  let started: Start | undefined;
  const showProgress = (): void => {
    const now = starts.get(dir);
    if (now !== started) {
      started?.listeners.delete(showProgress);
      started = now;
      started?.listeners.add(showProgress);
    }
    progress.visible = started !== undefined;
    if (started === undefined) return;
    progressBuffer.text = started.lines.length === 0 ? '(en attente de la sortie de devenv…)' : started.lines.join('\n');
    const adj = progress.get_vadjustment();
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      adj.value = adj.upper - adj.pageSize;
      return GLib.SOURCE_REMOVE;
    });
    render();
  };
  onStarts(box, dir, showProgress);
  box.connect('map', showProgress);
  box.connect('unmap', () => {
    started?.listeners.delete(showProgress);
    started = undefined;
  });

  /** action en cours (bouton désactivé, libellé) : null au repos */
  let busy: string | null = null;
  let state: DevenvState | null = null;
  let watcher: { fast: (on: boolean) => void; refresh: () => void } | null = null;
  const act = (what: string, run: () => Promise<void>): void => {
    busy = what;
    render();
    run()
      .catch((e: unknown) => ctx.toast(`${d.name} : ${errorMessage(e)}`))
      .finally(() => {
        busy = null;
        watcher?.refresh();
        render();
      });
  };

  const row = (p: DevenvProcess, idle: boolean): Gtk.Widget => {
    const kind = phaseKind(p.phase);
    const r = new Gtk.Box({ spacing: 8, marginTop: 4, marginBottom: 4, marginStart: 8, marginEnd: 4 });
    r.append(dot(kind));
    const labels = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
    labels.append(new Gtk.Label({ label: p.name, xalign: 0, ellipsize: Pango.EllipsizeMode.END }));
    labels.append(new Gtk.Label({ label: `${phaseLabel(p.phase)}${p.restarts > 0 ? ` · ${p.restarts} redémarrage${p.restarts > 1 ? 's' : ''}` : ''}${p.ports === undefined ? '' : ` · ${p.ports}`}`, xalign: 0, cssClasses: ['caption', 'dim-label'] }));
    r.append(labels);
    const button = (icon: string, tooltip: string, run: () => void, css: string[] = []): void => {
      const b = new Gtk.Button({ iconName: icon, tooltipText: tooltip, valign: Gtk.Align.CENTER, sensitive: idle, cssClasses: ['flat', 'circular', ...css] });
      b.connect('clicked', run);
      r.append(b);
    };
    const managerOn = state?.kind === 'running';
    // process manager arrêté : démarrer un service le lance aussi (évaluation Nix : sortie suivie)
    if (!managerOn) button('media-playback-start-symbolic', `Démarrer ${p.name}`, () => startStreamed(dir, `Démarrage de ${p.name} (et du process manager)…`, 'start', p.name, d.name, ctx, () => watcher?.refresh()));
    else if (kind === 'stopped' || kind === 'failed') button('media-playback-start-symbolic', `Démarrer ${p.name}`, () => act(`Démarrage de ${p.name}…`, () => devenvAction(dir, 'start', p.name)));
    else button('media-playback-stop-symbolic', `Arrêter ${p.name}`, () => act(`Arrêt de ${p.name}…`, () => devenvAction(dir, 'stop', p.name)), ['terminal-stop']);
    if (managerOn) {
      button('view-refresh-symbolic', `Redémarrer ${p.name}`, () => act(`Redémarrage de ${p.name}…`, () => devenvAction(dir, 'restart', p.name)));
      button('text-x-generic-symbolic', `Logs de ${p.name}`, () => openLogs(box, dir, p.name));
    }
    return r;
  };

  let signature = '';
  /** services connus (cache) : affichés arrêtés quand le process manager ne tourne pas */
  const cached = (): readonly string[] => (ctx.settings.data.peek().devenvs[project] ?? []).find((x) => x.id === d.id)?.services ?? [];
  const render = (): void => {
    const starting = starts.get(dir);
    const effectiveBusy = busy ?? starting?.what ?? null;
    const sig = `${effectiveBusy ?? ''}|${JSON.stringify(state)}|${cached().join(',')}`;
    if (sig === signature) return;
    signature = sig;
    list.remove_all();
    const running = state?.kind === 'running';
    all.sensitive = effectiveBusy === null && state !== null;
    all.child = new Adw.ButtonContent({ label: running ? 'Tout arrêter' : 'Tout démarrer', iconName: running ? 'media-playback-stop-symbolic' : 'media-playback-start-symbolic' });
    all.tooltipText = running ? 'Arrêter le process manager et tous les services (devenv processes down)' : 'Démarrer tous les services en arrière-plan (devenv up --detach)';
    const rows: DevenvProcess[] = state?.kind === 'running' ? [...state.processes] : state?.kind === 'stopped' ? cached().map((name) => ({ name, phase: 'stopped', restarts: 0 })) : [];
    for (const p of rows) list.append(row(p, effectiveBusy === null));
    list.visible = rows.length > 0;
    message.label =
      effectiveBusy ??
      (state === null
        ? 'Lecture de l’état…'
        : state.kind === 'stopped'
          ? rows.length > 0
            ? 'Process manager arrêté (services du dernier démarrage).'
            : 'Process manager arrêté : « Tout démarrer » lance devenv up en arrière-plan.'
          : state.kind === 'error'
            ? state.message
            : state.processes.length === 0
              ? 'Aucun service.'
              : '');
    message.visible = message.label !== '';
  };
  all.connect('clicked', () => {
    if (state?.kind === 'running') act('Arrêt de tous les services…', () => devenvAction(dir, 'down'));
    // devenv up évalue la configuration Nix : peut prendre plusieurs dizaines de secondes ; sortie suivie
    else startStreamed(dir, 'Démarrage de tous les services (devenv up)…', 'up', undefined, d.name, ctx, () => watcher?.refresh());
  });
  refresh.connect('clicked', () => watcher?.refresh());
  watcher = watchWhileMapped(box, dir, (s) => {
    state = s;
    remember(ctx, project, d.id, s);
    render();
  });
  render();
  return { widget: box, visible: (on) => watcher?.fast(on) };
}

/** Panneau dans un dialogue (depuis le menu d'un dossier). */
export function openDevenvDialog(parent: Gtk.Widget, d: ProjectDevenv, project: string, ctx: DevenvContext): void {
  const panel = DevenvPanel(d, project, ctx);
  const dialog = new Adw.Dialog({ title: d.name, contentWidth: 420 });
  const toolbar = new Adw.ToolbarView({ content: panel.widget });
  toolbar.add_top_bar(new Adw.HeaderBar());
  dialog.child = toolbar;
  panel.visible(true);
  dialog.connect('closed', () => panel.visible(false));
  dialog.present(parent);
}

// ------------------------------------------------------------------ pastille

/** Menu contextuel d'un élément devenv. */
export function devenvMenu(widget: Gtk.Widget, d: ProjectDevenv, project: string, ctx: DevenvContext, extra: () => readonly (readonly MenuItem[])[] = () => [], host?: MenuHost): void {
  const anchor = host?.anchor ?? widget;
  attachContextMenu(widget, () =>
    hosted(host, [
      [
        { label: 'Tout démarrer', activate: () => startStreamed(devenvDir(d, project), 'Démarrage de tous les services (devenv up)…', 'up', undefined, d.name, ctx, noop) },
        { label: 'Tout arrêter', activate: () => void devenvAction(devenvDir(d, project), 'down').catch((e: unknown) => ctx.toast(`${d.name} : ${errorMessage(e)}`)) },
      ],
      [
        { label: 'Modifier…', activate: () => askDevenv(anchor, project, ctx, d) },
        { label: 'Retirer…', activate: () => askRemoveDevenv(anchor, project, d, ctx) },
      ],
      ...extra(),
    ]),
  );
}

/** État affiché par une pastille ou une ligne : point coloré et résumé. */
export function devenvStatusWidget(d: ProjectDevenv, project: string, ctx: DevenvContext): Gtk.Widget {
  const box = new Gtk.Box({ spacing: 6 });
  const indicator = new Gtk.Box({ cssClasses: ['devenv-dot', KIND_CLASS.busy], valign: Gtk.Align.CENTER });
  const text = new Gtk.Label({ label: '…', cssClasses: ['caption'] });
  box.append(indicator);
  box.append(text);
  const dir = devenvDir(d, project);
  let last: DevenvState | null = null;
  const show = (): void => {
    const sum = starts.has(dir) ? { text: 'démarrage…', kind: 'busy' as const } : summary(last);
    indicator.cssClasses = ['devenv-dot', KIND_CLASS[sum.kind]];
    text.label = sum.text;
    box.tooltipText = last?.kind === 'error' ? last.message : null;
  };
  watchWhileMapped(box, dir, (s) => {
    last = s;
    remember(ctx, project, d.id, s);
    show();
  });
  onStarts(box, dir, show);
  return box;
}

/** Pastille d'un devenv : état du process manager ; clic : panneau des services. */
export function DevenvPill({ d, project, ctx, extra }: { d: ProjectDevenv; project: string; ctx: DevenvContext; extra?: () => readonly (readonly MenuItem[])[] }): Gtk.Widget {
  const button = new Gtk.MenuButton({ cssClasses: ['folder-pill', 'devenv-pill'], tooltipText: `devenv « ${d.name} » : services de ${prettyPath(devenvDir(d, project))}`, valign: Gtk.Align.CENTER });
  const box = new Gtk.Box({ spacing: 6 });
  box.append(new Gtk.Image({ iconName: 'system-run-symbolic', pixelSize: 14 }));
  box.append(new Gtk.Label({ label: d.name }));
  box.append(devenvStatusWidget(d, project, ctx));
  box.append(new Gtk.Image({ iconName: 'pan-down-symbolic', pixelSize: 12 }));
  button.child = box;
  const toggle = button.get_first_child();
  // le bouton à menu lui-même aussi : sinon son nom concatène le contenu du menu
  button.update_property([Gtk.AccessibleProperty.LABEL], [button.tooltipText ?? '']);
  if (toggle !== null) toggle.update_property([Gtk.AccessibleProperty.LABEL], [button.tooltipText ?? d.name]);
  const popover = new Gtk.Popover();
  const panel = DevenvPanel(d, project, ctx);
  popover.child = panel.widget;
  popover.connect('show', () => panel.visible(true));
  popover.connect('closed', () => panel.visible(false));
  button.popover = popover;
  devenvMenu(button, d, project, ctx, extra);
  return button;
}
