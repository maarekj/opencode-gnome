// Notifications de bureau (Gio.Notification) : session terminée, question, permission, erreur.
// Uniquement quand l'application tourne. Une notification par session (identifiant stable) :
// remplacée plutôt qu'empilée, retirée quand on ouvre la session.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GSound from 'gi://GSound';
import type Adw from 'gi://Adw?version=1';
import type { Settings } from '../shared/settings.ts';
import { isWorking, type Activity, type Store } from '../shared/store.ts';

export interface NotifierOptions {
  app: Adw.Application;
  store: Store;
  settings: Settings;
  /** session affichée dans la fenêtre active (pas de notification pour elle), sinon null */
  focusedSession: () => string | null;
}

export const notificationId = (sessionID: string): string => `session-${sessionID}`;

/** OPENCODE_GNOME_TEST_NOTIFY=1 : notifications journalisées (`NOTIF …`), pour les tests. */
const TEST = GLib.getenv('OPENCODE_GNOME_TEST_NOTIFY') !== null;

/** Sons du thème de sons du bureau (spécification freedesktop des noms d'événements). */
const SOUND_NOTIFY = 'message-new-instant';
const SOUND_FOCUSED = 'message';

/** Contexte de sons, créé à la première utilisation (null si le son est indisponible). */
let sounds: GSound.Context | null | undefined;
function playSound(eventID: string): void {
  if (sounds === undefined) {
    try {
      sounds = new GSound.Context();
      sounds.init(null);
    } catch (e) {
      console.error(`sons indisponibles : ${String(e)}`);
      sounds = null;
    }
  }
  if (TEST) console.log(`SON ${eventID}`);
  try {
    sounds?.play_simple({ [GSound.ATTR_EVENT_ID]: eventID, [GSound.ATTR_EVENT_DESCRIPTION]: 'opencode' }, null);
  } catch {
    // son absent du thème : silencieux
  }
}

export class Notifier {
  readonly #o: NotifierOptions;
  /** activité connue de chaque session (null tant que le premier chargement n'est pas fait) */
  #previous: Map<string, Activity> | null = null;
  readonly #stops: (() => void)[] = [];

  constructor(o: NotifierOptions) {
    this.#o = o;
    this.#stops.push(o.store.projects.subscribe(() => this.#diff()));
    // question annexe (#153) : erreur visible dans son panneau, pas de notification
    this.#stops.push(o.store.onSessionError((id, message) => (o.store.isHidden(id) ? undefined : this.#notify(id, 'Erreur', message, 'error'))));
  }

  dispose(): void {
    for (const stop of this.#stops) stop();
  }

  /** Retire la notification d'une session (session ouverte, demande traitée). */
  withdraw(sessionID: string): void {
    this.#o.app.withdraw_notification(notificationId(sessionID));
  }

  #diff(): void {
    const { store } = this.#o;
    if (store.connection.peek().state !== 'connected') return;
    const current = new Map<string, Activity>();
    for (const p of store.projects.peek()) for (const v of p.sessions) current.set(v.session.id, v.activity);
    const previous = this.#previous;
    this.#previous = current;
    // premier chargement : état de référence, pas de notification pour ce qui existait déjà
    if (previous === null) return;
    for (const [id, now] of current) {
      const before = previous.get(id) ?? 'idle';
      if (now === before) continue;
      if (now === 'question') this.#notify(id, 'Question', 'L’agent attend ta réponse.', 'question');
      else if (now === 'permission') this.#notify(id, 'Permission demandée', 'L’agent attend ton autorisation.', 'permission');
      else if (now === 'idle' && isWorking(before)) this.#notify(id, 'Terminé', 'La session a fini de répondre.', 'done');
      // la demande a été traitée, refusée ou annulée (réponse depuis la console, l'app…, session
      // passée directement au repos) : notification retirée (#94)
      else if (before === 'question' || before === 'permission') this.withdraw(id);
    }
  }

  #notify(sessionID: string, what: string, body: string, kind: 'done' | 'question' | 'permission' | 'error'): void {
    const { app, store, settings, focusedSession } = this.#o;
    const { notifications, notificationSound } = settings.data.peek();
    if (!notifications) return;
    const session = store.session(sessionID);
    if (session === undefined) return; // sous-agent ou session inconnue
    // session affichée dans la fenêtre active : déjà sous les yeux, juste le son « message »
    if (focusedSession() === sessionID) {
      if (notificationSound) playSound(SOUND_FOCUSED);
      return;
    }
    if (notificationSound) playSound(SOUND_NOTIFY);
    const title = `${what} · ${session.title === '' ? 'Sans titre' : session.title}`;
    const project = GLib.path_get_basename(session.directory);
    const n = new Gio.Notification();
    n.set_title(title);
    n.set_body(`${project} — ${body}`);
    n.set_priority(kind === 'done' ? Gio.NotificationPriority.NORMAL : Gio.NotificationPriority.HIGH);
    n.set_default_action_and_target('app.open-session', new GLib.Variant('s', sessionID));
    const permission = kind === 'permission' ? store.pendingPermission(sessionID) : undefined;
    if (permission === undefined) {
      n.add_button_with_target('Ouvrir', 'app.open-session', new GLib.Variant('s', sessionID));
    } else {
      const target = (reply: string): GLib.Variant => new GLib.Variant('(ssss)', [sessionID, session.directory, permission, reply]);
      n.add_button_with_target('Refuser', 'app.reply-permission', target('reject'));
      n.add_button_with_target('Autoriser', 'app.reply-permission', target('once'));
    }
    if (TEST) console.log(`NOTIF ${notificationId(sessionID)} | ${title} | ${project} — ${body}${permission === undefined ? '' : ` | permission ${permission}`}`);
    app.send_notification(notificationId(sessionID), n);
  }
}
