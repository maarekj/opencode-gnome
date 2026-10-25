// Fenêtre « Tâches planifiées » : liste des tâches (activer, lancer, modifier, supprimer), éditeur,
// historique des runs (clic : session ouverte dans l'application). Même configuration que la CLI
// `ogt` ; les unités systemd sont régénérées à chaque enregistrement.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createState, type Accessor } from 'gnim';
import { errorMessage } from '../shared/errors.ts';
import { esc, fmtDuration, fmtRelative, fmtStamp } from '../shared/format.ts';
import { prettyPath, type Store } from '../shared/store.ts';
import {
  describeSchedule,
  isManual,
  isFailure,
  loadRuns,
  loadTasks,
  markFailuresSeen,
  newTaskId,
  parseSchedule,
  removeTask,
  runsPath,
  saveTask,
  startRun,
  stopRun,
  tasksPath,
  timerState,
  unseenFailures,
  type RunRecord,
  type ScheduledTask,
} from '../shared/tasks.ts';


export const STATUS: Readonly<Record<RunRecord['status'], { icon: string; label: string; css: string }>> = {
  running: { icon: 'content-loading-symbolic', label: 'En cours', css: 'accent' },
  success: { icon: 'object-select-symbolic', label: 'Réussi', css: 'success' },
  error: { icon: 'dialog-error-symbolic', label: 'Échec', css: 'error' },
  timeout: { icon: 'alarm-symbolic', label: 'Délai dépassé', css: 'error' },
  cancelled: { icon: 'media-playback-stop-symbolic', label: 'Annulé', css: 'dim-label' },
  skipped: { icon: 'action-unavailable-symbolic', label: 'Sauté', css: 'warning' },
};

// ------------------------------------------------------------------ suivi des fichiers

/**
 * Tâches et runs suivis sur disque (CLI, timers et application écrivent les mêmes fichiers) :
 * `version` change à chaque modification, `unseen` = échecs pas encore vus dans l'historique.
 */
/** Tâche avec son état (systemd) et son dernier run. */
export interface TaskView {
  readonly task: ScheduledTask;
  readonly running: boolean;
  readonly next: number | null;
  readonly last: RunRecord | null;
}

const taskViewKey = (v: TaskView): string => JSON.stringify([v.task, v.running, v.next, v.last?.run, v.last?.status]);

export class TasksMonitor {
  readonly version: Accessor<number>;
  readonly unseen: Accessor<number>;
  /** tâches et leur état, relus à chaque modification et périodiquement (run en cours, prochaine exécution) */
  readonly tasks: Accessor<readonly TaskView[]>;
  readonly #setVersion: (v: number) => void;
  readonly #setUnseen: (v: number) => void;
  readonly #setTasks: (v: readonly TaskView[]) => void;
  #seq = 0;
  readonly #monitors: Gio.FileMonitor[] = [];
  #queued = 0;

  constructor() {
    [this.version, this.#setVersion] = createState(0);
    [this.unseen, this.#setUnseen] = createState(unseenFailures().length);
    [this.tasks, this.#setTasks] = createState<readonly TaskView[]>([], { equals: (a, b) => a.length === b.length && a.every((x, i) => taskViewKey(x) === taskViewKey(b[i] ?? x)) });
    void this.#reloadTasks();
    GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 10, () => {
      void this.#reloadTasks();
      return GLib.SOURCE_CONTINUE;
    });
    for (const path of [tasksPath(), runsPath()]) {
      GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
      const m = Gio.File.new_for_path(path).monitor_file(Gio.FileMonitorFlags.NONE, null);
      m.connect('changed', () => this.changed());
      this.#monitors.push(m);
    }
  }

  /** Signale une modification (regroupée). */
  changed(): void {
    if (this.#queued !== 0) return;
    this.#queued = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
      this.#queued = 0;
      this.#setUnseen(unseenFailures().length);
      this.#setVersion(this.version.peek() + 1);
      void this.#reloadTasks();
      return GLib.SOURCE_REMOVE;
    });
  }

  async #reloadTasks(): Promise<void> {
    const seq = (this.#seq += 1);
    try {
      const tasks = loadTasks();
      const runs = loadRuns();
      const states = await Promise.all(tasks.map((t) => timerState(t)));
      if (seq !== this.#seq) return;
      this.#setTasks(
        tasks.map((task, i) => ({
          task,
          running: states[i]?.active ?? false,
          next: task.enabled ? (states[i]?.next ?? null) : null,
          last: runs.find((r) => r.task === task.id) ?? null,
        })),
      );
    } catch (e) {
      console.error(`tâches planifiées : ${errorMessage(e)}`);
    }
  }

  markSeen(): void {
    markFailuresSeen();
    this.#setUnseen(0);
  }
}

// ------------------------------------------------------------------ éditeur

interface Choice {
  readonly label: string;
  readonly value: string;
}

/** Lignes de la liste déroulante : libellé complet (pas d'ellipse), la liste s'élargit. */
function fullLabelFactory(inRow = false): Gtk.SignalListItemFactory {
  const factory = new Gtk.SignalListItemFactory();
  factory.connect('setup', (_f: Gtk.SignalListItemFactory, item: GObject.Object) => {
    if (!(item instanceof Gtk.ListItem)) return;
    // valeur affichée dans la ligne : une seule ligne, coupée seulement faute de place
    item.child = inRow
      ? new Gtk.Label({ xalign: 1, ellipsize: Pango.EllipsizeMode.END })
      : new Gtk.Label({ xalign: 0, maxWidthChars: 70, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR });
  });
  factory.connect('bind', (_f: Gtk.SignalListItemFactory, item: GObject.Object) => {
    if (!(item instanceof Gtk.ListItem)) return;
    const label = item.child;
    const str = item.item;
    if (label instanceof Gtk.Label && str instanceof Gtk.StringObject) label.label = str.string;
  });
  return factory;
}

/**
 * Liste déroulante de choix. `keep` : une valeur absente de la liste (session supprimée, modèle
 * retiré…) est conservée comme option « (introuvable) » au lieu de basculer en silence sur le
 * premier choix, ce qui modifierait la tâche au simple enregistrement (#69).
 */
function comboRow(
  title: string,
  choices: readonly Choice[],
  value: string | undefined,
  subtitle = '',
): { row: Adw.ComboRow; get: () => string; set: (c: readonly Choice[], v?: string, keep?: boolean) => void } {
  const row = new Adw.ComboRow({ title, subtitle, useSubtitle: false, factory: fullLabelFactory(true), listFactory: fullLabelFactory() });
  let current: readonly Choice[] = [];
  const set = (c: readonly Choice[], v?: string, keep = false): void => {
    if (keep && v !== undefined && v !== '' && !c.some((x) => x.value === v)) c = [{ label: `${v} (introuvable)`, value: v }, ...c];
    current = c;
    row.model = Gtk.StringList.new(c.map((x) => x.label));
    row.selected = Math.max(0, c.findIndex((x) => x.value === v));
  };
  set(choices, value);
  return { row, get: () => current[row.selected]?.value ?? '', set };
}

const PRESETS: readonly Choice[] = [
  { label: 'Tous les jours', value: 'daily' },
  { label: 'En semaine (lun. → ven.)', value: 'weekdays' },
  { label: 'Chaque lundi', value: 'monday' },
  { label: 'Toutes les heures', value: 'hourly' },
  { label: 'Personnalisé (cron ou OnCalendar)', value: 'custom' },
  { label: 'À la main uniquement (pas de planification)', value: 'manual' },
];

/** Préréglage et heure d'un horaire existant, sinon « personnalisé ». */
function presetOf(task: ScheduledTask | undefined): { preset: string; time: string; custom: string } {
  if (task === undefined) return { preset: 'weekdays', time: '09:00', custom: '' };
  if (isManual(task)) return { preset: 'manual', time: '09:00', custom: '' };
  const m = /^(?:(\S+) )?\*-\*-\* (\d\d):(\d\d):00$/u.exec(task.schedule);
  if (task.cron === undefined && m !== null) {
    const days = m[1];
    const time = `${m[2] ?? '09'}:${m[3] ?? '00'}`;
    if (days === undefined) return { preset: 'daily', time, custom: '' };
    if (days === 'Mon..Fri') return { preset: 'weekdays', time, custom: '' };
    if (days === 'Mon') return { preset: 'monday', time, custom: '' };
  }
  if (task.cron === undefined && task.schedule === '*-*-* *:00:00') return { preset: 'hourly', time: '09:00', custom: '' };
  return { preset: 'custom', time: '09:00', custom: task.cron ?? task.schedule };
}

function scheduleExpr(preset: string, time: string, custom: string): string {
  switch (preset) {
    case 'daily':
      return `*-*-* ${time}:00`;
    case 'weekdays':
      return `Mon..Fri *-*-* ${time}:00`;
    case 'monday':
      return `Mon *-*-* ${time}:00`;
    case 'hourly':
      return 'hourly';
    case 'manual':
      return '';
    default:
      return custom;
  }
}

export interface EditorContext {
  readonly store: Store;
  readonly monitor: TasksMonitor;
  readonly toast: (m: string) => void;
}

/** Éditeur d'une tâche (nouvelle si `task` est absent). */
export function openEditor(parent: Gtk.Widget, ctx: EditorContext, task?: ScheduledTask, initialDir?: string): void {
  const { store } = ctx;
  const dialog = new Adw.Dialog({ title: task === undefined ? 'Nouvelle tâche' : 'Modifier la tâche', contentWidth: 820, contentHeight: 1000 });
  const overlay = new Adw.ToastOverlay();
  const toast = (m: string): void => overlay.add_toast(new Adw.Toast({ title: esc(m), timeout: 5 }));

  // ---- tâche
  const name = new Adw.EntryRow({ title: 'Nom', text: task?.name ?? '' });
  // projets connus d'opencode (+ dossier actuel de la tâche s'il n'y figure plus)
  const known = store.projects.peek();
  // nom seul, chemin ajouté seulement si deux projets ont le même nom
  const projects: Choice[] = known.map((p) => ({ label: known.filter((q) => q.name === p.name).length > 1 ? `${p.name} (${prettyPath(p.path)})` : p.name, value: p.path }));
  // dossier de la tâche ou dossier de départ (favori sans session…) absent de la liste : ajouté
  // en tête, sinon le premier projet serait choisi à sa place (#68)
  const wanted = task?.directory ?? initialDir;
  if (wanted !== undefined && !projects.some((p) => p.value === wanted)) projects.unshift({ label: prettyPath(wanted), value: wanted });
  const project = comboRow('Projet', projects, task?.directory ?? initialDir);
  project.row.enableSearch = true;
  project.row.searchMatchMode = Gtk.StringFilterMatchMode.SUBSTRING;
  project.row.expression = Gtk.PropertyExpression.new(Gtk.StringObject.$gtype, null, 'string');
  let directory = project.get();
  const general = new Adw.PreferencesGroup({ title: 'Tâche' });
  general.add(name);
  general.add(project.row);

  // ---- horaire
  const initial = presetOf(task);
  const preset = comboRow('Fréquence', PRESETS, initial.preset);
  const time = new Adw.EntryRow({ title: 'Heure (HH:MM)', text: initial.time });
  const custom = new Adw.EntryRow({ title: 'Expression (cron « 0 9 * * 1-5 » ou OnCalendar « Mon..Fri 09:00 »)', text: initial.custom });
  custom.tooltipText =
    'cron : les 5 champs classiques « minute heure jour mois jour-de-la-semaine », ex. « 30 8 * * 1-5 » (8 h 30 en semaine).\n' +
    'OnCalendar : la syntaxe des horaires de systemd (qui lance les tâches), plus lisible, ex. « Mon..Fri 08:30 », « *-*-01 09:00 » (le 1er du mois), « daily », « hourly ».\n' +
    'La ligne « Prochaine exécution » vérifie l\'expression pendant la saisie.';
  const preview = new Adw.ActionRow({ title: 'Prochaine exécution', subtitle: '…', cssClasses: ['property'] });
  const when = new Adw.PreferencesGroup({ title: 'Horaire', description: 'Un créneau manqué (ordinateur éteint) est rattrapé au démarrage.' });
  for (const r of [preset.row, time, custom, preview]) when.add(r);
  const expr = (): string => scheduleExpr(preset.get(), time.text.trim(), custom.text.trim());
  let previewSeq = 0;
  const updatePreview = (): void => {
    time.visible = ['daily', 'weekdays', 'monday'].includes(preset.get());
    custom.visible = preset.get() === 'custom';
    const seq = (previewSeq += 1);
    enabled.visible = preset.get() !== 'manual';
    when.description = preset.get() === 'manual' ? '' : 'Un créneau manqué (ordinateur éteint) est rattrapé au démarrage.';
    if (preset.get() === 'manual') {
      preview.subtitle = 'Jamais automatiquement : lance-la avec « Lancer maintenant » (ou ogt run)';
      preview.remove_css_class('error');
      return;
    }
    parseSchedule(expr()).then(
      (s) => {
        if (seq !== previewSeq) return null;
        preview.subtitle = esc(`${s.next === undefined ? '—' : `${fmtStamp(s.next)} (${fmtRelativeFuture(s.next)})`} · ${describeSchedule(s.schedule)}`);
        preview.remove_css_class('error');
        return null;
      },
      (e: unknown) => {
        if (seq !== previewSeq) return;
        preview.subtitle = esc(errorMessage(e).replace(/^horaire invalide : /u, 'Horaire invalide : '));
        preview.add_css_class('error');
      },
    );
  };
  preset.row.connect('notify::selected', updatePreview);
  time.connect('changed', updatePreview);
  custom.connect('changed', updatePreview);

  // ---- prompt
  const prompt = new Gtk.TextView({ wrapMode: Gtk.WrapMode.WORD_CHAR, topMargin: 10, bottomMargin: 10, leftMargin: 12, rightMargin: 12, acceptsTab: false });
  prompt.buffer.text = task?.prompt ?? '';
  const promptGroup = new Adw.PreferencesGroup({ title: 'Prompt' });
  promptGroup.add(new Gtk.ScrolledWindow({ child: prompt, minContentHeight: 140, maxContentHeight: 280, propagateNaturalHeight: true, hscrollbarPolicy: Gtk.PolicyType.NEVER, cssClasses: ['card'] }));

  // ---- exécution
  const model = comboRow('Modèle', [{ label: 'Par défaut', value: '' }], task?.model ?? '');
  const variant = comboRow('Niveau de réflexion', [{ label: 'Par défaut', value: '' }], task?.variant ?? '');
  variant.row.visible = false;
  /** niveaux de raisonnement de chaque modèle (`fournisseur/modèle` -> noms), dans l'ordre du serveur */
  let variantsOf = new Map<string, string[]>();
  const updateVariants = (): void => {
    const names = variantsOf.get(model.get()) ?? [];
    variant.row.visible = names.length > 0;
    variant.set([{ label: 'Par défaut', value: '' }, ...names.map((n) => ({ label: n, value: n }))], variant.get() || task?.variant);
  };
  model.row.connect('notify::selected', updateVariants);
  const agent = comboRow('Agent', [{ label: 'Par défaut', value: '' }], task?.agent ?? '');
  const timeout = Adw.SpinRow.new_with_range(1, 24 * 60, 5);
  timeout.title = 'Durée maximale (min)';
  timeout.subtitle = 'Au-delà, le run est interrompu';
  timeout.value = task?.timeout ?? 30;
  const permissions = comboRow(
    'Permissions',
    [
      { label: 'Toutes autorisées', value: 'all' },
      { label: 'Demander (le run attend ta réponse)', value: 'ask' },
    ],
    task?.permissions ?? 'all',
  );
  const sessionMode = comboRow(
    'Session',
    [
      { label: 'Nouvelle session à chaque run', value: 'new' },
      { label: 'Session réutilisée (créée au premier run)', value: 'reuse' },
      { label: 'Session existante réutilisée', value: 'pinned' },
    ],
    task === undefined ? 'new' : task.session.mode === 'new' ? 'new' : task.session.pinned === true ? 'pinned' : 'reuse',
  );
  const existing = comboRow('Session existante', [], task?.session.pinned === true ? task.session.id : undefined);
  const sessionHint = new Adw.ActionRow({ subtitle: 'Session réutilisée : l’agent garde le contexte des runs précédents. Si elle est occupée à l’heure du run, le run est sauté.', cssClasses: ['dim-label'] });
  const enabled = new Adw.SwitchRow({ title: 'Activée', active: task?.enabled ?? true });
  const execution = new Adw.PreferencesGroup({ title: 'Exécution' });
  for (const r of [model.row, variant.row, agent.row, timeout, permissions.row, sessionMode.row, existing.row, sessionHint, enabled]) execution.add(r);
  // longues listes : recherche (sur tout le libellé)
  for (const r of [model.row, existing.row]) {
    r.enableSearch = true;
    r.searchMatchMode = Gtk.StringFilterMatchMode.SUBSTRING;
    r.expression = Gtk.PropertyExpression.new(Gtk.StringObject.$gtype, null, 'string');
  }
  const updateSession = (): void => {
    existing.row.visible = sessionMode.get() === 'pinned';
    sessionHint.visible = sessionMode.get() !== 'new';
  };
  sessionMode.row.connect('notify::selected', updateSession);
  updateSession();

  /** Choix dépendant du dossier : modèles, agents, sessions. */
  /** numéro du dernier chargement : changer vite de projet n'affiche pas les choix de l'ancien (#92) */
  let choicesGeneration = 0;
  const loadChoices = async (): Promise<void> => {
    if (directory === '') return;
    const gen = ++choicesGeneration;
    const sessions = store.projects
      .peek()
      .flatMap((p) => p.sessions)
      .filter((v) => v.session.directory === directory)
      .map((v) => ({ label: v.session.title === '' ? v.session.id : v.session.title, value: v.session.id }));
    // session épinglée de la tâche, dans son dossier : conservée même absente de la liste
    const pinned = task?.session.pinned === true && task.directory === directory ? task.session.id : undefined;
    const wantedSession = existing.get() || pinned;
    existing.set(
      sessions.length === 0 && pinned === undefined ? [{ label: 'Aucune session dans ce dossier', value: '' }] : sessions,
      wantedSession,
      wantedSession !== undefined && wantedSession === pinned,
    );
    try {
      const [providers, agents] = await Promise.all([store.client.providers(directory), store.client.agents(directory)]);
      if (gen !== choicesGeneration) return;
      const models = providers.providers.flatMap((p) => Object.values(p.models).map((m) => ({ label: `${m.name ?? m.id} — ${p.name ?? p.id} (${m.id})`, value: `${p.id}/${m.id}` })));
      variantsOf = new Map(providers.providers.flatMap((p) => Object.values(p.models).map((m) => [`${p.id}/${m.id}`, Object.keys(m.variants ?? {})] as const)));
      model.set([{ label: 'Par défaut', value: '' }, ...models.toSorted((a, b) => a.label.localeCompare(b.label))], model.get() || task?.model, true);
      updateVariants();
      const primary = agents.filter((a) => a.mode !== 'subagent' && a.hidden !== true).map((a) => ({ label: a.name, value: a.name }));
      agent.set([{ label: 'Par défaut', value: '' }, ...primary], agent.get() || task?.agent, true);
    } catch (e) {
      if (gen === choicesGeneration) toast(`Modèles et agents indisponibles : ${errorMessage(e)}`);
    }
  };

  project.row.connect('notify::selected', () => {
    directory = project.get();
    void loadChoices();
  });

  // ---- enregistrement
  const save = new Gtk.Button({ label: task === undefined ? 'Créer' : 'Enregistrer', cssClasses: ['suggested-action'] });
  const cancel = new Gtk.Button({ label: 'Annuler' });
  cancel.connect('clicked', () => {
    dialog.close();
  });
  save.connect('clicked', () => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- utilise l'état du dialogue
    const go = async (): Promise<void> => {
      const text = prompt.buffer.text.trim();
      if (name.text.trim() === '') throw new Error('Nom requis');
      if (directory === '') throw new Error('Projet requis');
      if (text === '') throw new Error('Prompt requis');
      const s = preset.get() === 'manual' ? { schedule: '' } : await parseSchedule(expr());
      const mode = sessionMode.get();
      const pinned = existing.get();
      if (mode === 'pinned' && pinned === '') throw new Error('Choisis une session existante');
      // session réutilisée créée par un run précédent : conservée tant que le mode ne change pas
      const keep = task?.session.mode === 'reuse' && task.session.pinned !== true && task.directory === directory ? task.session.id : undefined;
      const next: ScheduledTask = {
        id: task?.id ?? newTaskId(name.text.trim()),
        name: name.text.trim(),
        directory,
        prompt: text,
        schedule: s.schedule,
        timeout: Math.round(timeout.value),
        permissions: permissions.get() === 'ask' ? 'ask' : 'all',
        session: mode === 'new' ? { mode: 'new' } : mode === 'pinned' ? { mode: 'reuse', id: pinned, pinned: true } : keep === undefined ? { mode: 'reuse' } : { mode: 'reuse', id: keep },
        // une tâche manuelle n'a rien à activer : toujours lançable
        enabled: preset.get() === 'manual' ? true : enabled.active,
        created: task?.created ?? Date.now(),
        ...('cron' in s && s.cron !== undefined ? { cron: s.cron } : {}),
        ...(model.get() === '' ? {} : { model: model.get() }),
        ...(agent.get() === '' ? {} : { agent: agent.get() }),
        // niveau valable seulement pour le modèle choisi
        ...(variant.get() === '' || !variant.row.visible ? {} : { variant: variant.get() }),
      };
      save.sensitive = false;
      await saveTask(next);
      ctx.monitor.changed();
      ctx.toast(task === undefined ? `Tâche « ${next.name} » créée` : `Tâche « ${next.name} » enregistrée`);
      dialog.close();
    };
    go().catch((e: unknown) => {
      save.sensitive = true;
      toast(errorMessage(e));
    });
  });

  const header = new Adw.HeaderBar({ showEndTitleButtons: false, showStartTitleButtons: false });
  header.pack_start(cancel);
  header.pack_end(save);
  // plus large qu'une PreferencesPage (600 px) : libellés des listes lisibles
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 24, marginTop: 24, marginBottom: 24, marginStart: 12, marginEnd: 12 });
  for (const g of [general, when, promptGroup, execution]) box.append(g);
  overlay.child = new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, child: new Adw.Clamp({ maximumSize: 780, tighteningThreshold: 600, child: box }) });
  const view = new Adw.ToolbarView({ content: overlay });
  view.add_top_bar(header);
  dialog.child = view;
  dialog.defaultWidget = save;
  updatePreview();
  void loadChoices();
  dialog.present(parent);
  if (task === undefined) name.grab_focus();
}

/** « dans 2 h », « dans 3 j » */
function fmtRelativeFuture(ms: number): string {
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  if (s < 60) return 'dans moins d’une minute';
  const m = Math.round(s / 60);
  if (m < 60) return `dans ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `dans ${h} h`;
  return `dans ${Math.round(h / 24)} j`;
}

// ------------------------------------------------------------------ fenêtre

export function confirmDelete(parent: Gtk.Widget, task: ScheduledTask, remove: () => void): void {
  const dialog = new Adw.AlertDialog({
    heading: 'Supprimer la tâche ?',
    body: `« ${task.name} » ne sera plus planifiée. Les sessions de ses runs sont conservées.`,
    defaultResponse: 'cancel',
    closeResponse: 'cancel',
  });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('delete', 'Supprimer');
  dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
  dialog.connect('response', (_d: Adw.AlertDialog, r: string) => {
    if (r === 'delete') remove();
  });
  dialog.present(parent);
}

const durationOf = (r: RunRecord): string => (r.end === undefined ? '' : fmtDuration(r.end - r.start));

let current: Adw.Window | null = null;

export interface TasksWindowOptions {
  readonly app: Adw.Application;
  readonly store: Store;
  readonly monitor: TasksMonitor;
  /** dossier proposé pour une nouvelle tâche (projet affiché) */
  readonly directory?: string;
  /** page à afficher */
  readonly page?: 'tasks' | 'history';
}

export function openTasksWindow(o: TasksWindowOptions): void {
  if (current !== null) {
    current.present();
    return;
  }
  const { app, store, monitor } = o;
  const win = new Adw.Window({ application: app, title: 'Tâches planifiées', defaultWidth: 1000, defaultHeight: 820, resizable: true });
  current = win;
  const overlay = new Adw.ToastOverlay();
  const toast = (m: string): void => overlay.add_toast(new Adw.Toast({ title: esc(m), timeout: 4 }));
  const ctx: EditorContext = { store, monitor, toast };
  const act = (what: string, fn: () => Promise<void>, failed?: () => void): void => {
    fn()
      .then(() => monitor.changed())
      .catch((e: unknown) => {
        toast(`${what} : ${errorMessage(e)}`);
        failed?.();
      });
  };

  // ---- tâches
  const tasksGroup = new Adw.PreferencesGroup({ title: 'Tâches', description: 'Prompts lancés selon leur horaire (même quand l’application est fermée) ou à la main (▶).' });
  const addButton = new Gtk.Button({ iconName: 'list-add-symbolic', tooltipText: 'Nouvelle tâche', cssClasses: ['flat'] });
  addButton.connect('clicked', () => openEditor(win, ctx, undefined, o.directory));
  tasksGroup.headerSuffix = addButton;
  const tasksPage = new Adw.PreferencesPage();
  tasksPage.add(tasksGroup);
  const empty = new Adw.StatusPage({ iconName: 'alarm-symbolic', title: 'Aucune tâche planifiée', description: 'Planifie un prompt : revue quotidienne, veille, rapport hebdomadaire…' });
  const emptyButton = new Gtk.Button({ label: 'Nouvelle tâche', halign: Gtk.Align.CENTER, cssClasses: ['pill', 'suggested-action'] });
  emptyButton.connect('clicked', () => openEditor(win, ctx, undefined, o.directory));
  empty.child = emptyButton;
  const tasksStack = new Gtk.Stack();
  tasksStack.add_named(tasksPage, 'list');
  tasksStack.add_named(empty, 'empty');

  // ---- historique
  const failedOnly = new Adw.SwitchRow({ title: 'Échecs seulement' });
  const filterGroup = new Adw.PreferencesGroup();
  filterGroup.add(failedOnly);
  const runsGroup = new Adw.PreferencesGroup({ title: 'Derniers runs', description: 'Clic : ouvre la session du run.' });
  const historyPage = new Adw.PreferencesPage();
  historyPage.add(filterGroup);
  historyPage.add(runsGroup);

  const stack = new Adw.ViewStack();
  stack.add_titled_with_icon(tasksStack, 'tasks', 'Tâches', 'alarm-symbolic');
  const historyTab = stack.add_titled_with_icon(historyPage, 'history', 'Historique', 'document-open-recent-symbolic');
  const header = new Adw.HeaderBar({ titleWidget: new Adw.ViewSwitcher({ stack, policy: Adw.ViewSwitcherPolicy.WIDE }) });
  const view = new Adw.ToolbarView({ content: stack });
  view.add_top_bar(header);
  overlay.child = view;
  win.content = overlay;

  // ---- remplissage
  const rows: Gtk.Widget[] = [];
  const runRows: Gtk.Widget[] = [];
  /**
   * Tâches : état lu par le moniteur (relu périodiquement, publié seulement s'il change) ; les
   * lignes ne sont reconstruites qu'à un changement réel, plus toutes les 5 s (#80).
   */
  const renderTasks = (): void => {
    const views = monitor.tasks.peek();
    for (const r of rows.splice(0)) tasksGroup.remove(r);
    tasksStack.visibleChildName = views.length === 0 ? 'empty' : 'list';
    for (const v of views) {
      const t = v.task;
      const st = { next: v.next, active: v.running };
      const last = v.last ?? undefined;
      const state = st.active ? 'en cours…' : isManual(t) ? '' : t.enabled ? (st.next === null ? 'pas de prochaine exécution' : `prochaine : ${fmtStamp(st.next)}`) : 'désactivée';
      const lastText = last === undefined ? 'jamais lancée' : `dernier run : ${STATUS[last.status].label.toLowerCase()} ${fmtRelative(last.start)}`;
      const row = new Adw.ActionRow({
        title: esc(t.name),
        subtitle: esc(`${[describeSchedule(t.schedule), state].filter((x) => x !== '').join(' · ')}\n${lastText} · ${prettyPath(t.directory)}`),
        subtitleLines: 2,
        activatable: true,
        tooltipText: t.prompt.slice(0, 400),
      });
      if (!t.enabled) row.add_css_class('dim-label');
      if (st.active) row.add_prefix(new Adw.Spinner());
      else {
        const s = last === undefined ? null : STATUS[last.status];
        row.add_prefix(new Gtk.Image({ iconName: s?.icon ?? 'alarm-symbolic', cssClasses: s === null ? ['dim-label'] : [s.css], tooltipText: s?.label ?? 'Jamais lancée' }));
      }
      const runBtn = new Gtk.Button({
        iconName: st.active ? 'media-playback-stop-symbolic' : 'media-playback-start-symbolic',
        tooltipText: st.active ? 'Interrompre le run' : 'Lancer maintenant',
        valign: Gtk.Align.CENTER,
        cssClasses: ['flat'],
      });
      runBtn.connect('clicked', () => act(st.active ? 'Arrêt impossible' : 'Lancement impossible', () => (st.active ? stopRun(t) : startRun(t))));
      // tâche manuelle : rien à activer (pas de planification)
      const sw = new Gtk.Switch({ active: t.enabled, valign: Gtk.Align.CENTER, tooltipText: t.enabled ? 'Désactiver' : 'Activer', visible: !isManual(t) });
      sw.connect('notify::active', () => {
        if (sw.active !== t.enabled)
          act('Modification impossible', () => saveTask({ ...t, enabled: sw.active }), () => {
            sw.active = t.enabled;
          });
      });
      const del = new Gtk.Button({ iconName: 'user-trash-symbolic', tooltipText: 'Supprimer', valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
      del.connect('clicked', () => confirmDelete(win, t, () => act('Suppression impossible', () => removeTask(t.id))));
      row.add_suffix(runBtn);
      row.add_suffix(sw);
      row.add_suffix(del);
      row.connect('activated', () => openEditor(win, ctx, t));
      tasksGroup.add(row);
      rows.push(row);
    }
  };

  /** Historique : relu à chaque modification du journal des runs ou du filtre. */
  const renderRuns = (): void => {
    const tasks = loadTasks();
    const runs = loadRuns();
    for (const r of runRows.splice(0)) runsGroup.remove(r);
    const names = new Map(tasks.map((t) => [t.id, t.name]));
    const shown = runs.filter((r) => !failedOnly.active || isFailure(r)).slice(0, 100);
    if (shown.length === 0) {
      const none = new Adw.ActionRow({ title: failedOnly.active ? 'Aucun échec' : 'Aucun run pour l’instant', cssClasses: ['dim-label'] });
      runsGroup.add(none);
      runRows.push(none);
    }
    for (const r of shown) {
      const s = STATUS[r.status];
      const detail = r.error ?? r.summary ?? '';
      const meta = [fmtStamp(r.start), durationOf(r), r.trigger === 'manual' ? 'lancé à la main' : 'planifié'].filter((x) => x !== '').join(' · ');
      const row = new Adw.ActionRow({
        title: esc(names.get(r.task) ?? r.task),
        subtitle: esc(detail === '' ? meta : `${meta}\n${detail}`),
        subtitleLines: 2,
        activatable: r.session !== undefined,
        tooltipText: detail,
      });
      row.add_prefix(r.status === 'running' ? new Adw.Spinner() : new Gtk.Image({ iconName: s.icon, cssClasses: [s.css], tooltipText: s.label }));
      if (r.session !== undefined) {
        const session = r.session;
        row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
        row.connect('activated', () => app.activate_action('open-session', new GLib.Variant('s', session)));
      }
      runsGroup.add(row);
      runRows.push(row);
    }
    historyTab.needsAttention = monitor.unseen.peek() > 0 && stack.visibleChildName !== 'history';
    historyTab.badgeNumber = monitor.unseen.peek();
  };
  const refreshRuns = (): void => {
    try {
      renderRuns();
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  const refresh = (): void => {
    renderTasks();
    refreshRuns();
  };
  failedOnly.connect('notify::active', refreshRuns);

  stack.connect('notify::visible-child-name', () => {
    if (stack.visibleChildName === 'history') monitor.markSeen();
    refreshRuns();
  });
  const unsubscribe = [monitor.tasks.subscribe(renderTasks), monitor.version.subscribe(refreshRuns), monitor.unseen.subscribe(refreshRuns)];
  win.connect('close-request', () => {
    for (const u of unsubscribe) u();
    current = null;
    return false;
  });

  if (o.page !== undefined) stack.visibleChildName = o.page;
  refresh();
  win.present();
}
