// Tâches planifiées : un prompt opencode lancé à heures régulières dans un dossier.
// Configuration dans ~/.config/opencode-gnome/tasks.json (seule source de vérité), planification
// par des timers systemd utilisateur générés à partir d'elle (pas de démon), journal des runs dans
// ~/.local/share/opencode-gnome/runs.jsonl. Partagé entre la CLI `ogt` et l'application.
//
// Espace de noms (OGT_NAMESPACE, posé par le lanceur) : vide pour l'installation principale,
// numéro du worktree sinon. Fichiers et unités séparés : un worktree ne planifie jamais les
// tâches de la version principale.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as z from 'zod/mini';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

export const TaskSession = z.object({
  /** new : une session par run ; reuse : le prompt devient un nouveau message de la même session */
  mode: z.enum(['new', 'reuse']),
  /** reuse : session utilisée (absente tant que le premier run ne l'a pas créée) */
  id: z.optional(z.string()),
  /** reuse : session choisie par l'utilisateur (jamais recréée si elle disparaît) */
  pinned: z.optional(z.boolean()),
});
export type TaskSession = z.output<typeof TaskSession>;

export const ScheduledTask = z.object({
  id: z.string(),
  name: z.string(),
  directory: z.string(),
  prompt: z.string(),
  /** horaire systemd (`OnCalendar`), forme normalisée ; vide : tâche lancée uniquement à la main */
  schedule: z.string(),
  /** saisie d'origine si elle était en syntaxe cron */
  cron: z.optional(z.string()),
  /** `fournisseur/modèle` ; absent = modèle par défaut */
  model: z.optional(z.string()),
  agent: z.optional(z.string()),
  variant: z.optional(z.string()),
  /** durée maximale d'un run, en minutes */
  timeout: z.prefault(z.int().check(z.positive()), 30),
  /** all : toutes les permissions accordées ; ask : le run attend la réponse de l'utilisateur */
  permissions: z.prefault(z.enum(['all', 'ask']), 'all'),
  session: z.prefault(TaskSession, { mode: 'new' }),
  enabled: z.prefault(z.boolean(), true),
  created: z.number(),
});
export type ScheduledTask = z.output<typeof ScheduledTask>;

const TasksFile = z.object({ tasks: z.prefault(z.array(ScheduledTask), []) });

export const RunStatus = z.enum(['running', 'success', 'error', 'timeout', 'cancelled', 'skipped']);
export type RunStatus = z.output<typeof RunStatus>;

export const RunRecord = z.object({
  run: z.string(),
  task: z.string(),
  /** schedule : timer ; manual : `ogt run` / l'app */
  trigger: z.enum(['schedule', 'manual']),
  status: RunStatus,
  start: z.number(),
  end: z.optional(z.number()),
  session: z.optional(z.string()),
  /** message utilisateur du run (session réutilisée : où commence le run) */
  message: z.optional(z.string()),
  error: z.optional(z.string()),
  /** début de la dernière réponse de l'agent */
  summary: z.optional(z.string()),
});
export type RunRecord = z.output<typeof RunRecord>;

// ------------------------------------------------------------------ chemins

export const namespace = (): string => GLib.getenv('OGT_NAMESPACE') ?? '';
const suffix = (): string => (namespace() === '' ? '' : `-${namespace()}`);

export const tasksPath = (): string => GLib.build_filenamev([GLib.get_user_config_dir(), 'opencode-gnome', `tasks${suffix()}.json`]);
export const runsPath = (): string => GLib.build_filenamev([GLib.get_user_data_dir(), 'opencode-gnome', `runs${suffix()}.jsonl`]);
/** Unités générées : ~/.config/systemd/user (OGT_UNIT_DIR pour les tests). */
const unitDir = (): string => GLib.getenv('OGT_UNIT_DIR') ?? GLib.build_filenamev([GLib.get_home_dir(), '.config', 'systemd', 'user']);
export const unitName = (id: string, type: 'service' | 'timer'): string => `opencode-gnome${suffix()}-task-${id}.${type}`;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function readText(path: string): string | null {
  try {
    const [ok, bytes] = GLib.file_get_contents(path);
    return ok ? decoder.decode(bytes) : null;
  } catch {
    return null;
  }
}

function writeText(path: string, text: string): void {
  GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
  GLib.file_set_contents(path, encoder.encode(text));
}

// ------------------------------------------------------------------ tâches

export function loadTasks(): ScheduledTask[] {
  const text = readText(tasksPath());
  if (text === null) return [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    // erreur explicite, avec le chemin du fichier (#100)
    throw new Error(`${tasksPath()} illisible (JSON invalide) : ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  const parsed = TasksFile.safeParse(json);
  if (!parsed.success) throw new Error(`${tasksPath()} illisible : ${z.prettifyError(parsed.error)}`);
  return parsed.data.tasks;
}

function saveTasks(tasks: readonly ScheduledTask[]): void {
  writeText(tasksPath(), `${JSON.stringify({ tasks }, null, 2)}\n`);
}

/** Tâche par identifiant ou par nom (sans casse). */
export function findTask(ref: string): ScheduledTask | undefined {
  const tasks = loadTasks();
  return tasks.find((t) => t.id === ref) ?? tasks.find((t) => t.name.toLowerCase() === ref.toLowerCase());
}

const slug = (s: string): string =>
  s
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036F]/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-|-$/gu, '')
    .slice(0, 24) || 'tache';

export function newTaskId(name: string): string {
  const taken = new Set(loadTasks().map((t) => t.id));
  let id = slug(name);
  for (let i = 2; taken.has(id); i += 1) id = `${slug(name)}-${i}`;
  return id;
}

/**
 * Lecture-modification-écriture de tasks.json sous verrou : l'app, `ogt` et les runs (`ogt exec`)
 * écrivent le même fichier (#70). Verrou par fichier `.lock` créé en exclusif ; un verrou de plus
 * de 10 s (processus tué) est ignoré.
 */
function updateTasks(fn: (tasks: ScheduledTask[]) => ScheduledTask[]): void {
  withLock(tasksPath(), () => saveTasks(fn(loadTasks())));
}

/** Exécute `fn` sous le verrou du fichier `path` (`path.lock` créé en exclusif ; périmé après 10 s). */
function withLock(path: string, fn: () => void): void {
  const lock = Gio.File.new_for_path(`${path}.lock`);
  GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      lock.create(Gio.FileCreateFlags.NONE, null).close(null);
      break;
    } catch {
      let age = 0;
      try {
        age = Date.now() / 1000 - (lock.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null).get_modification_date_time()?.to_unix() ?? 0);
      } catch {
        continue; // verrou retiré entre-temps : nouvel essai
      }
      if (age > 10 || Date.now() > deadline) {
        try {
          lock.delete(null);
        } catch {
          // retiré par un autre processus
        }
        continue;
      }
      GLib.usleep(20_000);
    }
  }
  try {
    fn();
  } finally {
    try {
      lock.delete(null);
    } catch {
      // déjà retiré
    }
  }
}

/**
 * Enregistre la tâche (ajout ou remplacement) et met ses unités systemd à jour. Session réutilisée
 * non épinglée : son identifiant est un état d'exécution (écrit par `ogt exec`), repris du fichier
 * plutôt que de la copie de l'appelant, peut-être antérieure au run qui l'a créée.
 */
export async function saveTask(task: ScheduledTask): Promise<void> {
  let saved = task;
  updateTasks((tasks) => {
    const current = tasks.find((t) => t.id === task.id);
    if (current !== undefined && task.session.mode === 'reuse' && task.session.pinned !== true && current.session.mode === 'reuse' && current.session.pinned !== true) {
      const { id: _stale, ...rest } = task.session;
      saved = { ...task, session: current.session.id === undefined ? rest : { ...rest, id: current.session.id } };
    }
    return current === undefined ? [...tasks, saved] : tasks.map((t) => (t.id === task.id ? saved : t));
  });
  await installUnits(saved);
}

/** Mise à jour partielle sans toucher aux unités (ex. session créée au premier run). */
export function patchTask(id: string, patch: Partial<ScheduledTask>): void {
  updateTasks((tasks) => tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)));
}

export async function removeTask(id: string): Promise<void> {
  await systemctl(['disable', '--now', unitName(id, 'timer')]).catch(() => '');
  await systemctl(['stop', unitName(id, 'service')]).catch(() => '');
  for (const type of ['timer', 'service'] as const) {
    try {
      Gio.File.new_for_path(GLib.build_filenamev([unitDir(), unitName(id, type)])).delete(null);
    } catch {
      // déjà absente
    }
  }
  updateTasks((tasks) => tasks.filter((t) => t.id !== id));
  await systemctl(['daemon-reload']);
}

// ------------------------------------------------------------------ horaire

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CRON_FIELD = /^[\d*,/\-A-Za-z]+$/u;

function cronPart(field: string, start: number, what: string): string {
  return field
    .split(',')
    .map((item) => {
      if (item === '*') return '*';
      const step = /^\*\/(\d+)$/u.exec(item);
      if (step !== null) return `${start}/${Number(step[1])}`;
      const range = /^(\d+)-(\d+)$/u.exec(item);
      if (range !== null) return `${Number(range[1])}..${Number(range[2])}`;
      if (/^\d+$/u.test(item)) return String(Number(item));
      throw new Error(`cron : « ${item} » non pris en charge dans le champ ${what} (utilise la syntaxe OnCalendar)`);
    })
    .join(',');
}

function cronDay(d: string): string {
  if (/^\d$/u.test(d)) return DAYS[Number(d)] ?? d;
  const name = d.slice(0, 3).toLowerCase();
  const found = DAYS.find((x) => x.toLowerCase() === name);
  if (found === undefined) throw new Error(`cron : jour « ${d} » inconnu`);
  return found;
}

function cronDays(field: string): string {
  if (field === '*') return '';
  return field
    .split(',')
    .map((item) => {
      const range = /^(\w+)-(\w+)$/u.exec(item);
      return range === null ? cronDay(item) : `${cronDay(range[1] ?? '')}..${cronDay(range[2] ?? '')}`;
    })
    .join(',');
}

/** Expression cron à 5 champs → `OnCalendar`, ou null si ce n'est pas du cron. */
export function cronToCalendar(input: string): string | null {
  const fields = input.trim().split(/\s+/u);
  if (fields.length !== 5 || !fields.every((f) => CRON_FIELD.test(f))) return null;
  const [minute = '*', hour = '*', dom = '*', month = '*', dow = '*'] = fields;
  // cron : jour du mois OU jour de la semaine ; systemd : les deux à la fois
  if (dom !== '*' && dow !== '*') throw new Error('cron : jour du mois et jour de la semaine ensemble non pris en charge (utilise OnCalendar)');
  const days = cronDays(dow);
  const date = `*-${cronPart(month, 1, 'mois')}-${cronPart(dom, 1, 'jour')}`;
  const time = `${cronPart(hour, 0, 'heure')}:${cronPart(minute, 0, 'minute')}:00`;
  return `${days === '' ? '' : `${days} `}${date} ${time}`;
}

/** Horaire saisi (cron ou OnCalendar) → forme normalisée par systemd ; lève une erreur s'il est invalide. */
export async function parseSchedule(input: string): Promise<{ schedule: string; cron?: string; next?: number }> {
  const fromCron = cronToCalendar(input);
  const expr = fromCron ?? input.trim();
  const { ok, out } = await run(['systemd-analyze', 'calendar', '--iterations=1', expr]);
  const normalized = /Normalized form: (.+)/u.exec(out)?.[1]?.trim();
  if (!ok || normalized === undefined) throw new Error(`horaire invalide : ${input} (${out.trim().split('\n').at(-1) ?? ''})`);
  // « From now: 1 day 12h left » n'est pas exploitable : prochaine occurrence relue en UTC
  const utc = /\(in UTC\): \w+ (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) UTC/u.exec(out)?.[1];
  const next = utc === undefined ? undefined : Date.parse(`${utc.replace(' ', 'T')}Z`);
  return {
    schedule: normalized,
    ...(fromCron === null ? {} : { cron: input.trim() }),
    ...(next === undefined || Number.isNaN(next) ? {} : { next }),
  };
}

// ------------------------------------------------------------------ systemd

async function run(argv: readonly string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Gio.Subprocess.new([...argv], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
  const [out] = await proc.communicate_utf8_async(null, null);
  return { ok: proc.get_successful(), out: out ?? '' };
}

async function systemctl(args: readonly string[]): Promise<string> {
  const { ok, out } = await run(['systemctl', '--user', ...args]);
  if (!ok) throw new Error(`systemctl ${args.join(' ')} : ${out.trim()}`);
  return out;
}

/** Variables transmises au run (serveur de test, réglages isolés, application à notifier). */
const PASSED_ENV = ['OPENCODE_GNOME_URL', 'OPENCODE_GNOME_APP_ID', 'OGT_NAMESPACE', 'OGT_UNIT_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'OPENCODE_GNOME_TEST_NOTIFY'];

/** Une valeur d'unité tient sur une ligne : un retour à la ligne injecterait des directives (#71). */
const oneLine = (s: string): string => s.replaceAll(/[\r\n]+/gu, ' ');
/** `%` introduit un spécificateur systemd (`%h`, `%n`…) : doublé pour rester littéral. */
const unitText = (s: string): string => oneLine(s).replaceAll('%', '%%');
const quoteUnit = (s: string): string => `"${unitText(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

export function serviceUnit(task: ScheduledTask, bin: string): string {
  const env = PASSED_ENV.map((k) => [k, GLib.getenv(k)] as const)
    .filter((e): e is readonly [string, string] => e[1] !== null)
    .map(([k, v]) => `Environment=${quoteUnit(`${k}=${v}`)}\n`)
    .join('');
  return `# Généré par opencode-gnome (ogt) : ne pas modifier, voir ${tasksPath()}
[Unit]
Description=opencode-gnome : tâche « ${unitText(task.name)} »

[Service]
Type=exec
ExecStart=${quoteUnit(bin)} exec ${quoteUnit(task.id)}
ExecStopPost=${quoteUnit(bin)} finalize ${quoteUnit(task.id)}
${env}# filet de sécurité : le run s'arrête lui-même à son timeout
RuntimeMaxSec=${task.timeout + 2}min
TimeoutStopSec=30
`;
}

export function timerUnit(task: ScheduledTask): string {
  return `# Généré par opencode-gnome (ogt) : ne pas modifier
[Unit]
Description=opencode-gnome : planification de « ${unitText(task.name)} »

[Timer]
OnCalendar=${oneLine(task.schedule)}
# exécution manquée (ordinateur éteint) : rattrapée au démarrage
Persistent=true
AccuracySec=1s
Unit=${unitName(task.id, 'service')}

[Install]
WantedBy=timers.target
`;
}

/** Exécutable `ogt` inscrit dans les unités (posé par le lanceur). */
const ogtBin = (): string => {
  const bin = GLib.getenv('OGT_BIN');
  if (bin === null) throw new Error('OGT_BIN absent : lance ogt via son lanceur (node scripts/install.ts)');
  return bin;
};

/** Tâche sans horaire : lancée uniquement à la main (pas de timer). */
export const isManual = (task: Pick<ScheduledTask, 'schedule'>): boolean => task.schedule === '';

export async function installUnits(task: ScheduledTask): Promise<void> {
  const bin = ogtBin();
  writeText(GLib.build_filenamev([unitDir(), unitName(task.id, 'service')]), serviceUnit(task, bin));
  if (isManual(task)) {
    // pas de planification : timer arrêté et retiré (le service reste lançable à la main)
    await systemctl(['disable', '--now', unitName(task.id, 'timer')]).catch(() => '');
    try {
      Gio.File.new_for_path(GLib.build_filenamev([unitDir(), unitName(task.id, 'timer')])).delete(null);
    } catch {
      // déjà absent
    }
    await systemctl(['daemon-reload']);
    return;
  }
  writeText(GLib.build_filenamev([unitDir(), unitName(task.id, 'timer')]), timerUnit(task));
  await systemctl(['daemon-reload']);
  await systemctl([task.enabled ? 'enable' : 'disable', '--now', unitName(task.id, 'timer')]);
  // timer déjà actif : prendre en compte un nouvel horaire
  if (task.enabled) await systemctl(['restart', unitName(task.id, 'timer')]);
}

/** Lance un run maintenant (via systemd : détaché, journalisé, timeout appliqué). */
export async function startRun(task: ScheduledTask): Promise<void> {
  await systemctl(['start', '--no-block', unitName(task.id, 'service')]);
}

export async function stopRun(task: ScheduledTask): Promise<void> {
  await systemctl(['stop', '--no-block', unitName(task.id, 'service')]);
}

/** Prochaine exécution (ms) et run en cours, lus dans systemd. */
export async function timerState(task: ScheduledTask): Promise<{ next: number | null; active: boolean }> {
  const out = await systemctl(['show', '--timestamp=unix', '-p', 'NextElapseUSecRealtime', unitName(task.id, 'timer'), '-p', 'ActiveState', unitName(task.id, 'service')]).catch(() => '');
  const next = /NextElapseUSecRealtime=@(\d+)/u.exec(out)?.[1];
  // ActiveState du timer puis du service (même ordre que les unités)
  const states = [...out.matchAll(/ActiveState=(\w+)/gu)].map((m) => m[1]);
  return { next: next === undefined ? null : Number(next) * 1000, active: states.at(-1) === 'active' || states.at(-1) === 'activating' };
}

// ------------------------------------------------------------------ journal des runs

export const newRunId = (): string => `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;

/** Ajoute l'état d'un run (début, puis fin) ; la dernière ligne d'un run fait foi. */
/** Au-delà de cette taille, le journal est compacté aux KEEP_RUNS runs les plus récents (#99). */
const MAX_RUNS_BYTES = 2 * 1024 * 1024;
const KEEP_RUNS = 1000;

export function recordRun(r: RunRecord): void {
  const path = runsPath();
  withLock(path, () => {
    const file = Gio.File.new_for_path(path);
    const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
    stream.write_all(encoder.encode(`${JSON.stringify(r)}\n`), null);
    stream.close(null);
    // compaction : une ligne par run (dernier état), les plus récents seulement
    const size = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
    if (size <= MAX_RUNS_BYTES) return;
    const keep = loadRuns().slice(0, KEEP_RUNS).toReversed();
    writeText(path, keep.map((x) => `${JSON.stringify(x)}\n`).join(''));
  });
}

/** Runs du plus récent au plus ancien. */
export function loadRuns(taskID?: string): RunRecord[] {
  const text = readText(runsPath());
  if (text === null) return [];
  const runs = new Map<string, RunRecord>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const r = RunRecord.safeParse(JSON.parse(line));
      if (r.success && (taskID === undefined || r.data.task === taskID)) runs.set(r.data.run, r.data);
    } catch {
      // ligne tronquée
    }
  }
  return [...runs.values()].toSorted((a, b) => b.start - a.start);
}

// ------------------------------------------------------------------ échecs non vus

const seenPath = (): string => GLib.build_filenamev([GLib.get_user_data_dir(), 'opencode-gnome', `runs-seen${suffix()}`]);
const FAILED: ReadonlySet<RunStatus> = new Set(['error', 'timeout', 'skipped']);
export const isFailure = (r: RunRecord): boolean => FAILED.has(r.status);

/** Runs en échec terminés après le dernier passage dans l'historique. */
export function unseenFailures(runs: readonly RunRecord[] = loadRuns()): RunRecord[] {
  // fichier corrompu (NaN) : 0, tous les échecs sont signalés plutôt qu'aucun (#99)
  const seen = Number(readText(seenPath()) ?? '0') || 0;
  return runs.filter((r) => isFailure(r) && (r.end ?? r.start) > seen);
}

export function markFailuresSeen(): void {
  writeText(seenPath(), String(Date.now()));
}

// ------------------------------------------------------------------ horaire lisible

const DAY_FR: Readonly<Record<string, string>> = { Mon: 'lundi', Tue: 'mardi', Wed: 'mercredi', Thu: 'jeudi', Fri: 'vendredi', Sat: 'samedi', Sun: 'dimanche' };

/** « tous les jours à 09:00 », « en semaine à 09:00 », « le lundi à 09:00 », « toutes les heures »… ; sinon l'expression. */
export function describeSchedule(schedule: string): string {
  if (schedule === '') return 'à la main';
  const m = /^(?:(\S+) )?\*-\*-\* (\d\d|\*):(\d\d)(?:\/(\d+))?:00$/u.exec(schedule);
  if (m === null) return schedule;
  const [, days, hour = '', minute = '', step] = m;
  let when: string;
  if (hour === '*') {
    if (step === undefined) when = minute === '00' ? 'toutes les heures' : `toutes les heures à :${minute}`;
    else when = `toutes les ${Number(step)} min`;
  } else if (step === undefined) when = `à ${hour}:${minute}`;
  else return schedule;
  if (days === undefined) return hour === '*' ? when : `tous les jours ${when}`;
  if (days === 'Mon..Fri') return `en semaine ${when}`;
  if (days === 'Sat,Sun' || days === 'Sat..Sun') return `le week-end ${when}`;
  const list = days.split(',').map((d) => DAY_FR[d]);
  if (list.some((d) => d === undefined)) return schedule;
  return `le ${list.join(', ')} ${when}`;
}
