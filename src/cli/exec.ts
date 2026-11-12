// Exécution d'un run (`ocg task exec`, lancé par le service systemd de la tâche) : session nouvelle ou
// réutilisée sur le serveur partagé, envoi du prompt, attente de la fin, journal et notification.
import GLib from 'gi://GLib';
import { OpencodeClient } from '../shared/client.ts';
import { serverUrl } from '../shared/config.ts';
import { errorMessage, HttpError } from '../shared/errors.ts';
import { listenV2 } from '../shared/v2/client.ts';
import * as E from '../shared/v2/events.ts';
import { AssistantMessage, HistoryEntry } from '../shared/v2/messages.ts';
import * as z from 'zod/mini';
import { loadRuns, newRunId, patchTask, recordRun, type RunRecord, type RunStatus, type ScheduledTask } from '../shared/tasks.ts';
import { notify } from './notify.ts';

/** Intervalle de vérification de l'état de la session (filet si un événement est manqué). */
const POLL_MS = 10_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    });
  });

function noop(): void {
  // rien à réveiller
}

/**
 * Attend `ms`, ou moins si `signal.wake()` est appelé ; la minuterie est retirée au réveil.
 */
function waitFor(signal: { wake: () => void }, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      signal.wake = noop;
      resolve();
      return GLib.SOURCE_REMOVE;
    });
    signal.wake = () => {
      GLib.source_remove(timer);
      signal.wake = noop;
      resolve();
    };
  });
}

/** Session créée (sous-agent : parent). */
const Created = z.object({ sessionID: z.string(), parentID: z.optional(z.string()) });

const stamp = (ms: number): string => GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000)).format('%d/%m %H:%M') ?? '';

/** Serveur joignable, démarré au besoin (unité de l'installation principale). */
async function ensureServer(client: OpencodeClient): Promise<void> {
  try {
    await client.health();
    return;
  } catch {
    // serveur partagé seulement : un autre serveur (test, OPENCODE_GNOME_URL) n'est pas démarré ici (#101)
    if (GLib.getenv('OPENCODE_GNOME_URL') !== null) throw new Error(`serveur opencode injoignable (${client.url})`);
    try {
      GLib.spawn_command_line_async('systemctl --user start opencode-gnome-server.service');
    } catch (e) {
      throw new Error(`démarrage du serveur partagé impossible : ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  }
  for (let i = 0; i < 30; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- attente du démarrage
    await sleep(500);
    // oxlint-disable-next-line no-await-in-loop
    if (await client.health().then(() => true, () => false)) return;
  }
  throw new Error(`serveur opencode injoignable (${client.url})`);
}

const DONE_TITLE: Readonly<Record<RunStatus, string>> = {
  running: 'En cours',
  success: 'Terminée',
  error: 'Échec',
  timeout: 'Délai dépassé',
  cancelled: 'Annulée',
  skipped: 'Run sauté',
};

function finish(task: ScheduledTask, r: RunRecord): void {
  recordRun(r);
  if (r.status === 'running') return;
  const ok = r.status === 'success';
  notify({
    id: r.session === undefined ? `task-${task.id}` : `session-${r.session}`,
    title: `${DONE_TITLE[r.status]} · ${task.name}`,
    body: (ok ? r.summary : r.error) ?? GLib.path_get_basename(task.directory),
    urgent: !ok,
    ...(r.session === undefined ? {} : { sessionID: r.session }),
  });
}

export async function execTask(task: ScheduledTask, trigger: RunRecord['trigger']): Promise<RunStatus> {
  const client = new OpencodeClient(serverUrl());
  const base: RunRecord = { run: newRunId(), task: task.id, trigger, status: 'running', start: Date.now() };
  const fail = (status: RunStatus, error: string, extra: Partial<RunRecord> = {}): RunStatus => {
    finish(task, { ...base, ...extra, status, error, end: Date.now() });
    return status;
  };
  try {
    await ensureServer(client);
  } catch (e) {
    return fail('error', errorMessage(e));
  }
  const dir = task.directory;

  // ------------------------------------------------ session
  let sessionID: string;
  if (task.session.mode === 'reuse' && task.session.id !== undefined) {
    let exists = true;
    try {
      await client.session(task.session.id);
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 404)) return fail('error', errorMessage(e));
      exists = false;
    }
    if (!exists && task.session.pinned === true) return fail('error', `session ${task.session.id} introuvable (supprimée ?)`);
    sessionID = exists ? task.session.id : '';
    if (exists) {
      const statuses = await client.statuses().catch(() => ({}));
      const st: unknown = Reflect.get(statuses, sessionID);
      if (typeof st === 'object' && st !== null && 'type' in st && st.type !== 'idle') {
        return fail('skipped', 'la session est occupée : run sauté (relance-le quand elle est libre)', { session: sessionID });
      }
    }
  } else sessionID = '';
  if (sessionID === '') {
    const title = task.session.mode === 'reuse' ? `[tâche] ${task.name}` : `[tâche] ${task.name} · ${stamp(base.start)}`;
    try {
      sessionID = (await client.createSession(dir, { title, allowAll: task.permissions === 'all' })).id;
    } catch (e) {
      return fail('error', `création de la session : ${errorMessage(e)}`);
    }
    if (task.session.mode === 'reuse') patchTask(task.id, { session: { ...task.session, id: sessionID } });
  }
  const r: RunRecord = { ...base, session: sessionID };
  recordRun(r);

  // ------------------------------------------------ suivi
  /** sessions du run : la session et ses sous-agents */
  const tree = new Set([sessionID]);
  let userMessage: string | undefined;
  /** étapes de l'agent vues pendant le run */
  const steps = new Set<string>();
  let sawBusy = false;
  let ended = false;
  /** fin d'exécution signalée par le flux : échec (message) ou interruption */
  let outcome: { failed?: string; interrupted?: boolean } = {};
  /** réveil de la boucle d'attente, erreur d'envoi du prompt */
  const signal: { wake: () => void; sendError: string | null } = { wake: noop, sendError: null };

  const inTree = async (id: string): Promise<boolean> => {
    if (tree.has(id)) return true;
    const s = await client.session(id).catch(() => null);
    if (s?.parentID !== undefined && (await inTree(s.parentID))) {
      tree.add(id);
      return true;
    }
    return false;
  };

  let sent = false;
  const sendPrompt = async (): Promise<void> => {
    if (sent) return;
    sent = true;
    const slash = task.model?.indexOf('/') ?? -1;
    await client.prompt(sessionID, dir, task.prompt, {
      ...(task.agent === undefined ? {} : { agent: task.agent }),
      ...(task.model === undefined || slash < 0 ? {} : { model: { providerID: task.model.slice(0, slash), modelID: task.model.slice(slash + 1) } }),
      ...(task.variant === undefined ? {} : { variant: task.variant }),
    });
  };

  const stop = listenV2(
    client,
    (json) => {
      const env = E.Envelope.safeParse(json);
      if (!env.success) return;
      const { type, data } = env.data;
      const sid = E.Sid.safeParse(data);
      const id = sid.success ? sid.data.sessionID : null;
      if (type === 'session.created') {
        const c = Created.safeParse(data);
        if (c.success && c.data.parentID !== undefined && tree.has(c.data.parentID)) tree.add(c.data.sessionID);
      } else if (id !== sessionID) {
        if (type === 'permission.asked' && task.permissions === 'all') autoAllow(data);
      } else if (type === 'session.execution.started') sawBusy = true;
      else if (type === 'session.execution.succeeded' || type === 'session.execution.failed' || type === 'session.execution.interrupted') {
        if (!sawBusy) return;
        const failed = E.ExecutionFailed.safeParse(data);
        outcome = type === 'session.execution.failed' ? { failed: failed.success ? failed.data.error.message : 'échec' } : type === 'session.execution.interrupted' ? { interrupted: true } : {};
        ended = true;
        signal.wake();
      } else if (type === 'session.inbox.delivered') {
        const d = E.InboxDelivered.safeParse(data);
        if (d.success) userMessage ??= d.data.inboxID;
      } else if (type === 'session.step.started') {
        const d = E.StepStarted.safeParse(data);
        if (d.success) steps.add(d.data.assistantMessageID);
      } else if (type === 'permission.asked' && task.permissions === 'all') autoAllow(data);
    },
    (connected) => {
      // prompt envoyé une fois le flux ouvert : aucun événement du run n'est manqué
      if (connected) sendPrompt().catch((e: unknown) => {
        signal.sendError = errorMessage(e);
        signal.wake();
      });
    },
  );
  /** toutes les permissions accordées : y compris aux sous-agents et à une session réutilisée */
  function autoAllow(data: unknown): void {
    const p = E.PermissionAsked.safeParse(data);
    if (!p.success) return;
    const { id, sessionID: sid } = p.data;
    void inTree(sid).then((mine) => (mine ? client.replyPermission(id, dir, 'once') : null)).catch(() => null);
  }

  // ------------------------------------------------ attente
  const deadline = base.start + task.timeout * 60_000;
  let status: RunStatus = 'success';
  let error: string | undefined;
  for (;;) {
    // événement arrivé pendant le contrôle précédent (filet) : pas d'attente (#101)
    // oxlint-disable-next-line no-await-in-loop -- attente d'un événement ou du prochain contrôle
    if (!ended && signal.sendError === null) await waitFor(signal, POLL_MS);
    if (signal.sendError !== null) {
      status = 'error';
      error = `envoi du prompt : ${signal.sendError}`;
      break;
    }
    if (ended) break;
    if (Date.now() > deadline) {
      status = 'timeout';
      error = `délai de ${task.timeout} min dépassé : run interrompu`;
      // oxlint-disable-next-line no-await-in-loop
      await client.abort(sessionID, dir).catch(() => null);
      break;
    }
    // filet : la session n'est plus active alors que le prompt est parti
    if (sent && Date.now() - base.start > POLL_MS) {
      // oxlint-disable-next-line no-await-in-loop
      const statuses = await client.statuses().catch(() => null);
      if (statuses !== null && statuses[sessionID] === undefined && (sawBusy || steps.size > 0)) break;
    }
  }
  stop();

  // ------------------------------------------------ résultat
  const page = await client.v2.messages({ sessionID, limit: 50 }).catch(() => ({ items: [] }));
  const mine = page.items
    .flatMap((raw) => {
      const e = HistoryEntry.safeParse(raw);
      return e.success && e.data.time.created >= base.start - 1000 ? [e.data] : [];
    })
    .toReversed();
  userMessage ??= mine.find((m) => m.type === 'user')?.id;
  const replies = mine.flatMap((m) => {
    const a = AssistantMessage.safeParse(m);
    return a.success ? [a.data] : [];
  });
  const failed = replies.map((m) => m.error).find((e) => e !== undefined)?.message ?? outcome.failed;
  if (status === 'success' && outcome.interrupted === true) {
    status = 'cancelled';
    error = 'run interrompu';
  } else if (status === 'success' && failed !== undefined) {
    status = 'error';
    error = failed;
  }
  const lastText = replies
    .flatMap((m) => m.content)
    .flatMap((c) => (c.type === 'text' ? [c.text] : []))
    .findLast((t) => t.trim() !== '');
  finish(task, {
    ...r,
    status,
    end: Date.now(),
    ...(userMessage === undefined ? {} : { message: userMessage }),
    ...(error === undefined ? {} : { error }),
    ...(lastText === undefined ? {} : { summary: lastText.trim().replaceAll(/\s+/gu, ' ').slice(0, 200) }),
  });
  return status;
}

/**
 * Après l'arrêt du service (`ExecStopPost`) : un run resté « en cours » a été tué par systemd
 * (arrêt demandé ou délai de sécurité dépassé) ; sa session est interrompue et le run clôturé.
 */
export async function finalizeTask(task: ScheduledTask): Promise<void> {
  const last = loadRuns(task.id)[0];
  if (last === undefined || last.status !== 'running') return;
  const client = new OpencodeClient(serverUrl());
  if (last.session !== undefined) await client.abort(last.session, task.directory).catch(() => null);
  const timeout = GLib.getenv('SERVICE_RESULT') === 'timeout';
  finish(task, { ...last, status: timeout ? 'timeout' : 'cancelled', end: Date.now(), error: timeout ? 'délai de sécurité dépassé (systemd)' : 'run arrêté' });
}
