// ogt : tâches planifiées d'opencode-gnome (prompts lancés à heures régulières).
// Même configuration que l'application ; planification par timers systemd utilisateur.
import GLib from 'gi://GLib';
import system from 'system';
import { errorMessage } from '../shared/errors.ts';
import {
  findTask,
  installUnits,
  isManual,
  loadRuns,
  loadTasks,
  newTaskId,
  parseSchedule,
  removeTask,
  saveTask,
  startRun,
  stopRun,
  tasksPath,
  timerState,
  type RunRecord,
  type ScheduledTask,
} from '../shared/tasks.ts';
import { execTask, finalizeTask } from './exec.ts';

const HELP = `ogt — tâches planifiées d'opencode-gnome

Usage :
  ogt list [--json]                      tâches, prochaine exécution, dernier run
  ogt show <tâche> [--json]
  ogt add --name NOM --dir DOSSIER (--at HORAIRE | --manual) (--prompt TEXTE | --prompt-file FICHIER) [options]
  ogt edit <tâche> [options]
  ogt run <tâche>                        lancer maintenant (en arrière-plan)
  ogt stop <tâche>                       interrompre le run en cours
  ogt enable | disable | rm <tâche>
  ogt history [<tâche>] [--failed] [--limit N] [--json]
  ogt sync                               régénérer les unités systemd de toutes les tâches

Options de tâche :
  --name NOM  --dir DOSSIER  --prompt TEXTE  --prompt-file FICHIER
  --at HORAIRE        cron (« 0 9 * * 1-5 ») ou OnCalendar systemd (« Mon..Fri 09:00 », « daily », « hourly »)
  --manual            pas d'horaire : tâche lancée uniquement à la main (ogt run, l'app)
  --model FOURNISSEUR/MODÈLE  --agent AGENT  --variant NIVEAU   (vide = défaut)
  --timeout MINUTES   durée maximale d'un run (30)
  --permissions all|ask    all : tout est autorisé ; ask : le run attend ta réponse (app, notification)
  --session new|reuse|ses_…  new : une session par run ; reuse : même session, créée au premier run ;
                      ses_… : session existante réutilisée (si elle est occupée, le run est sauté)
  --disabled | --enabled

<tâche> : identifiant ou nom. Configuration : ${tasksPath()}`;

// ------------------------------------------------------------------ arguments

interface Args {
  readonly positional: string[];
  readonly options: Map<string, string>;
  readonly flags: Set<string>;
}

const FLAGS = new Set(['json', 'failed', 'disabled', 'enabled', 'help', 'manual']);

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (a === '-h') flags.add('help');
    else if (a.startsWith('--')) {
      const [key = '', inline] = a.slice(2).split(/=(.*)/su);
      if (FLAGS.has(key)) flags.add(key);
      else {
        const value = inline ?? argv[(i += 1)];
        if (value === undefined) throw new Error(`--${key} : valeur manquante`);
        options.set(key, value);
      }
    } else positional.push(a);
  }
  return { positional, options, flags };
}

const expand = (p: string): string => {
  const path = p.startsWith('~/') || p === '~' ? GLib.build_filenamev([GLib.get_home_dir(), p.slice(1)]) : p;
  return GLib.canonicalize_filename(path, GLib.get_current_dir());
};

function readPromptFile(path: string): string {
  const [, bytes] = GLib.file_get_contents(expand(path));
  return new TextDecoder().decode(bytes).trim();
}

const optional = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v.trim());

/** Applique les options à une tâche (nouvelle ou existante). */
async function applyOptions(base: Partial<ScheduledTask>, o: Args['options'], flags: Args['flags']): Promise<ScheduledTask> {
  const t: Partial<ScheduledTask> = { ...base };
  const name = o.get('name');
  if (name !== undefined) t.name = name.trim();
  const dir = o.get('dir');
  if (dir !== undefined) {
    t.directory = expand(dir);
    if (!GLib.file_test(t.directory, GLib.FileTest.IS_DIR)) throw new Error(`dossier introuvable : ${t.directory}`);
  }
  const prompt = o.get('prompt') ?? (o.has('prompt-file') ? readPromptFile(o.get('prompt-file') ?? '') : undefined);
  if (prompt !== undefined) t.prompt = prompt;
  const at = o.get('at');
  if (at !== undefined && flags.has('manual')) throw new Error('--at et --manual sont incompatibles');
  if (flags.has('manual')) {
    t.schedule = '';
    delete t.cron;
  } else if (at !== undefined) {
    const { schedule, cron } = await parseSchedule(at);
    t.schedule = schedule;
    if (cron === undefined) delete t.cron;
    else t.cron = cron;
  }
  for (const key of ['model', 'agent', 'variant'] as const) {
    if (!o.has(key)) continue;
    const v = optional(o.get(key));
    if (v === undefined) delete t[key];
    else t[key] = v;
  }
  if (t.model !== undefined && !t.model.includes('/')) throw new Error('--model : format FOURNISSEUR/MODÈLE attendu');
  const timeout = o.get('timeout');
  if (timeout !== undefined) {
    const n = Number(timeout);
    if (!Number.isInteger(n) || n <= 0) throw new Error('--timeout : nombre de minutes attendu');
    t.timeout = n;
  }
  const perms = o.get('permissions');
  if (perms !== undefined) {
    if (perms !== 'all' && perms !== 'ask') throw new Error('--permissions : all ou ask');
    t.permissions = perms;
  }
  const session = o.get('session');
  if (session !== undefined) {
    if (session === 'new') t.session = { mode: 'new' };
    else if (session === 'reuse') t.session = { mode: 'reuse' };
    else if (session.startsWith('ses')) t.session = { mode: 'reuse', id: session, pinned: true };
    else throw new Error('--session : new, reuse ou un identifiant de session (ses_…)');
  }
  if (flags.has('disabled')) t.enabled = false;
  if (flags.has('enabled')) t.enabled = true;
  for (const key of ['name', 'directory', 'prompt'] as const) {
    if (t[key] === undefined || t[key] === '') throw new Error(`--${key === 'directory' ? 'dir' : key} est requis`);
  }
  if (t.schedule === undefined) throw new Error('--at HORAIRE ou --manual est requis');
  return {
    id: t.id ?? newTaskId(t.name ?? ''),
    name: t.name ?? '',
    directory: t.directory ?? '',
    prompt: t.prompt ?? '',
    schedule: t.schedule ?? '',
    timeout: t.timeout ?? 30,
    permissions: t.permissions ?? 'all',
    session: t.session ?? { mode: 'new' },
    enabled: t.enabled ?? true,
    created: t.created ?? Date.now(),
    ...(t.cron === undefined ? {} : { cron: t.cron }),
    ...(t.model === undefined ? {} : { model: t.model }),
    ...(t.agent === undefined ? {} : { agent: t.agent }),
    ...(t.variant === undefined ? {} : { variant: t.variant }),
  };
}

// ------------------------------------------------------------------ affichage

const fmt = (ms: number | null | undefined): string => (ms === null || ms === undefined ? '—' : (GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000)).format('%a %d/%m %H:%M') ?? ''));
const dur = (r: RunRecord): string => {
  if (r.end === undefined) return '';
  const s = Math.round((r.end - r.start) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
};
const ICON: Readonly<Record<RunRecord['status'], string>> = { running: '⏳', success: '✓', error: '✗', timeout: '⌛', cancelled: '⏹', skipped: '⤼' };

function need(ref: string | undefined): ScheduledTask {
  if (ref === undefined) throw new Error('tâche manquante (identifiant ou nom)');
  const t = findTask(ref);
  if (t === undefined) throw new Error(`tâche inconnue : ${ref}`);
  return t;
}

type Described = ScheduledTask & { next: number | null; running: boolean; last: RunRecord | null };

async function describe(t: ScheduledTask): Promise<Described> {
  const { next, active } = await timerState(t);
  const last = loadRuns(t.id)[0];
  return { ...t, next: t.enabled ? next : null, running: active, last: last ?? null };
}

// ------------------------------------------------------------------ commandes

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const ref = args.positional[0];
  const json = args.flags.has('json');
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      print(HELP);
      return 0;
    case 'list': {
      const tasks = await Promise.all(loadTasks().map((t) => describe(t)));
      if (json) print(JSON.stringify(tasks, null, 2));
      else if (tasks.length === 0) print('Aucune tâche. Ajoute-en une : ogt add --help');
      else
        for (const task of tasks) {
          const state = task.running ? 'en cours…' : isManual(task) ? 'lancée à la main (ogt run)' : task.enabled ? `prochaine : ${fmt(task.next)}` : 'désactivée';
          const last = task.last === null ? 'jamais lancée' : `dernier : ${ICON[task.last.status]} ${fmt(task.last.start)}`;
          print(`${task.id}  ${task.name}\n    ${isManual(task) ? 'à la main' : (task.cron ?? task.schedule)}  ·  ${state}  ·  ${last}\n    ${task.directory}`);
        }
      return 0;
    }
    case 'show': {
      const d = await describe(need(ref));
      print(JSON.stringify(d, null, 2));
      return 0;
    }
    case 'add': {
      if (args.flags.has('help')) {
        print(HELP);
        return 0;
      }
      const task = await applyOptions({}, args.options, args.flags);
      await saveTask(task);
      if (json) print(JSON.stringify(await describe(task), null, 2));
      else if (isManual(task)) print(`Tâche « ${task.name} » créée (${task.id}) · à la main : ogt run ${task.id}`);
      else print(`Tâche « ${task.name} » créée (${task.id}) · ${task.schedule}${task.enabled ? ` · prochaine : ${fmt((await timerState(task)).next)}` : ' · désactivée'}`);
      return 0;
    }
    case 'edit': {
      const current = need(ref);
      const task = await applyOptions(current, args.options, args.flags);
      // changement de mode de session : la session réutilisée précédente est oubliée
      await saveTask(task);
      print(`Tâche « ${task.name} » modifiée`);
      return 0;
    }
    case 'enable':
    case 'disable': {
      const task = { ...need(ref), enabled: command === 'enable' };
      await saveTask(task);
      print(`Tâche « ${task.name} » ${task.enabled ? 'activée' : 'désactivée'}`);
      return 0;
    }
    case 'rm': {
      const task = need(ref);
      await removeTask(task.id);
      print(`Tâche « ${task.name} » supprimée`);
      return 0;
    }
    case 'run': {
      const task = need(ref);
      await startRun(task);
      print(`Run de « ${task.name} » lancé (suivi : ogt history ${task.id}, journalctl --user -u opencode-gnome*-task-${task.id})`);
      return 0;
    }
    case 'stop': {
      const task = need(ref);
      await stopRun(task);
      print(`Arrêt du run de « ${task.name} » demandé`);
      return 0;
    }
    case 'history': {
      const task = ref === undefined ? undefined : need(ref);
      const names = new Map(loadTasks().map((t) => [t.id, t.name]));
      let runs = loadRuns(task?.id);
      if (args.flags.has('failed')) runs = runs.filter((r) => r.status !== 'success' && r.status !== 'running');
      runs = runs.slice(0, Number(args.options.get('limit') ?? 20));
      if (json) print(JSON.stringify(runs, null, 2));
      else if (runs.length === 0) print('Aucun run.');
      else
        for (const r of runs) {
          const detail = r.error ?? r.summary ?? '';
          print(`${ICON[r.status]} ${fmt(r.start)}  ${names.get(r.task) ?? r.task}  ${dur(r)}  ${r.trigger === 'manual' ? '(manuel)' : ''}${r.session === undefined ? '' : `  ${r.session}`}`);
          if (detail !== '') print(`    ${detail}`);
        }
      return 0;
    }
    case 'sync': {
      const tasks = loadTasks();
      for (const t of tasks) {
        // oxlint-disable-next-line no-await-in-loop -- systemctl séquentiel
        await installUnits(t);
      }
      print(`${tasks.length} tâche(s) synchronisée(s)`);
      return 0;
    }
    // ---- utilisées par les unités systemd
    case 'exec': {
      const task = need(ref);
      // TRIGGER_UNIT : posé par systemd quand le service est déclenché par son timer
      const status = await execTask(task, GLib.getenv('TRIGGER_UNIT') === null ? 'manual' : 'schedule');
      print(`run : ${status}`);
      return status === 'success' || status === 'skipped' ? 0 : 1;
    }
    case 'finalize':
      await finalizeTask(need(ref));
      return 0;
    default:
      throw new Error(`commande inconnue : ${command} (ogt help)`);
  }
}

// boucle principale explicite : les appels asynchrones (libsoup, sous-processus) en ont besoin
const loop = new GLib.MainLoop(null, false);
let code = 0;
const run = async (): Promise<void> => {
  try {
    code = await main(system.programArgs);
  } catch (e) {
    printerr(`ogt : ${errorMessage(e)}`);
    code = 2;
  }
  loop.quit();
};
void run();
loop.run();
system.exit(code);
