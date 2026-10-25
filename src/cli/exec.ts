// Exécution d'un run (`ocg task exec`, lancé par le service systemd de la tâche) : session nouvelle ou
// réutilisée sur le serveur partagé, envoi du prompt, attente de la fin, journal et notification.
import GLib from 'gi://GLib';
import { OpencodeClient } from '../shared/client.ts';
import { serverUrl } from '../shared/config.ts';
import { errorMessage, HttpError } from '../shared/errors.ts';
import type { MessageInfo } from '../shared/schemas.ts';
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
      const statuses = await client.statuses(dir).catch(() => ({}));
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
  const assistants = new Map<string, MessageInfo>();
  let sawBusy = false;
  let ended = false;
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

  const stop = client.listen(
    ({ event }) => {
      if (event.type === 'session.created' || event.type === 'session.updated') {
        const { id, parentID } = event.properties.info;
        if (parentID !== undefined && tree.has(parentID)) tree.add(id);
      } else if (event.type === 'session.status') {
        if (event.properties.sessionID !== sessionID) return;
        if (event.properties.status.type === 'busy') sawBusy = true;
        else if (event.properties.status.type === 'idle' && sawBusy) {
          ended = true;
          signal.wake();
        }
      } else if (event.type === 'session.idle') {
        if (event.properties.sessionID === sessionID && sawBusy) {
          ended = true;
          signal.wake();
        }
      } else if (event.type === 'message.updated') {
        const info = event.properties.info;
        if (info.sessionID !== sessionID || info.time.created < base.start - 1000) return;
        if (info.role === 'user') userMessage ??= info.id;
        else assistants.set(info.id, info);
      } else if ((event.type === 'permission.asked' || event.type === 'permission.v2.asked') && task.permissions === 'all') {
        // toutes les permissions accordées : y compris aux sous-agents et à une session réutilisée
        const { id, sessionID: sid } = event.properties;
        void inTree(sid).then((mine) => (mine ? client.replyPermission(id, dir, 'once') : null)).catch(() => null);
      }
    },
    (connected) => {
      // prompt envoyé une fois le flux ouvert : aucun événement du run n'est manqué
      if (connected) sendPrompt().catch((e: unknown) => {
        signal.sendError = errorMessage(e);
        signal.wake();
      });
    },
  );

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
      const statuses = await client.statuses(dir).catch(() => null);
      if (statuses !== null && statuses[sessionID] === undefined && (sawBusy || assistants.size > 0)) break;
    }
  }
  stop();

  // ------------------------------------------------ résultat
  const messages = await client.messages(sessionID, 50).catch(() => []);
  const mine = messages.filter((m) => m.info.time.created >= base.start - 1000);
  userMessage ??= mine.find((m) => m.info.role === 'user')?.info.id;
  const replies = mine.filter((m) => m.info.role === 'assistant');
  const failed = replies.map((m) => m.info.error).find((e) => e !== undefined);
  if (status === 'success' && failed !== undefined) {
    status = failed.name === 'MessageAbortedError' ? 'cancelled' : 'error';
    error = `${failed.name ?? 'Erreur'} : ${failed.data?.message ?? ''}`.trim();
  }
  const lastText = replies
    .flatMap((m) => m.parts)
    .filter((p) => p.type === 'text' && p.synthetic !== true)
    .map((p) => p.text ?? '')
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
