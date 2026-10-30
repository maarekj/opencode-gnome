// Question annexe (#153) : panneau à droite d'une conversation, avec une sous-conversation dans un
// fork caché de la session. Même contexte que la session, sans toucher à son flux.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { createComputed, createRoot, createState, type Accessor } from 'gnim';
import { Conversation } from '../shared/conversation.ts';
import { errorMessage, HttpError } from '../shared/errors.ts';
import type { Session } from '../shared/schemas.ts';
import type { Settings } from '../shared/settings.ts';
import type { Store } from '../shared/store.ts';
import { Composer, type ComposerProps } from './Composer.tsx';
import { ConversationView } from './ConversationView.tsx';
import type { RequestActions } from './Requests.tsx';

/** Préfixe du titre du fork (repérable depuis la console). */
export const ASIDE_TITLE = 'Question annexe';

/** Tokens en clair : « 18 k ». */
const fmt = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)} k` : String(n));

export interface AsideOptions {
  store: Store;
  settings: Settings;
  /** session principale */
  parentID: string;
  /** session principale (titre, dernière mise à jour) */
  parent: Accessor<Session | null>;
  dir: () => string;
  toast: (message: string) => void;
  /** agent, modèle et variante de la session principale (présélection) */
  initial: ComposerProps['initial'];
  loadChoices: ComposerProps['loadChoices'];
  findFiles: ComposerProps['findFiles'];
  showTools: Accessor<boolean>;
  /** ouvre une session (« Garder comme session ») */
  openSession: (sessionID: string) => void;
}

export interface AsideHandle {
  readonly widget: Gtk.Widget;
  /** panneau affiché */
  readonly shown: Accessor<boolean>;
  readonly toggle: () => void;
  readonly dispose: () => void;
}

/**
 * Point de fork : avant le premier message de l'assistant pas encore terminé (tour en cours de
 * la session principale, copié à moitié sinon) ; undefined : toute la session.
 */
async function forkPoint(o: AsideOptions): Promise<string | undefined> {
  const messages = await o.store.client.messages(o.parentID, 200);
  return messages.find((m) => m.info.role === 'assistant' && m.info.time.completed === undefined)?.info.id;
}

export function AsidePanel(o: AsideOptions): AsideHandle {
  const { store, settings, parentID, toast } = o;
  const client = store.client;
  const [shown, setShown] = createState(false);
  /** fork caché de la session (réglages) */
  const ref = settings.data((d) => d.asides[parentID] ?? null);
  /** conversation de la question annexe chargée dans le panneau */
  const [conv, setConv] = createState<Conversation | null>(null);
  let disposeView: (() => void) | null = null;

  const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, vexpand: true });
  const empty = new Adw.StatusPage({
    iconName: 'sidebar-show-right-symbolic',
    title: ASIDE_TITLE,
    description: "Pose une question sur cette session : la réponse s'affiche ici, avec le même contexte, sans interrompre l'agent ni toucher à la conversation.",
    cssClasses: ['compact'],
    vexpand: true,
  });

  /** Affiche la conversation de `id` (null : état vide). */
  const load = (id: string | null): void => {
    if (conv.peek()?.sessionID === id && (id !== null || disposeView === null)) return;
    disposeView?.();
    disposeView = null;
    conv.peek()?.dispose();
    for (let c = body.get_first_child(); c !== null; c = body.get_first_child()) body.remove(c);
    if (id === null) {
      setConv(null);
      body.append(empty);
      return;
    }
    const c = new Conversation(store, id);
    void c.start();
    setConv(c);
    const answer = async (send: () => Promise<void>): Promise<boolean> => {
      try {
        await send();
        return true;
      } catch (e) {
        toast(`Réponse impossible : ${errorMessage(e)}`);
        return false;
      } finally {
        void c.reloadRequests();
      }
    };
    const actions: RequestActions = {
      replyPermission: (rid, reply) => answer(() => client.replyPermission(rid, o.dir(), reply)),
      replyQuestion: (rid, answers) => answer(() => client.replyQuestion(rid, o.dir(), answers)),
      rejectQuestion: (rid) => answer(() => client.rejectQuestion(rid, o.dir())),
    };
    createRoot((dispose) => {
      disposeView = dispose;
      const [revealed] = createState(true);
      const view = ConversationView({ conversation: c, revealed, actions, showTools: o.showTools, maxWidth: createState(0)[0] });
      if (view instanceof Gtk.Widget) {
        view.vexpand = true;
        body.append(view);
      }
    });
  };

  /** Crée le fork caché (première question). */
  const create = async (): Promise<string> => {
    const existing = ref.peek();
    if (existing !== null) return existing.id;
    const at = Date.now();
    const fork = await client.forkSession(parentID, o.dir(), await forkPoint(o));
    // caché avant que l'événement du serveur ne l'ajoute aux projets
    settings.setAside(parentID, { id: fork.id, at });
    const title = o.parent.peek()?.title ?? '';
    await client.renameSession(fork.id, o.dir(), title === '' ? ASIDE_TITLE : `${ASIDE_TITLE} — ${title}`).catch((e: unknown) => console.error(e));
    load(fork.id);
    return fork.id;
  };

  /** Supprime le fork (Supprimer, Actualiser le contexte). */
  const remove = async (): Promise<void> => {
    const r = ref.peek();
    if (r === null) return;
    load(null);
    settings.setAside(parentID, null);
    try {
      await client.deleteSession(r.id, o.dir());
      store.removeSession(r.id);
    } catch (e) {
      toast(`Suppression de la question annexe impossible : ${errorMessage(e)}`);
    }
  };

  /** La question annexe devient une session normale, visible et ouverte. */
  const keep = async (): Promise<void> => {
    const r = ref.peek();
    if (r === null) return;
    try {
      const title = o.parent.peek()?.title ?? '';
      const s = await client.renameSession(r.id, o.dir(), title === '' ? ASIDE_TITLE : `${title} (${ASIDE_TITLE.toLowerCase()})`);
      load(null);
      settings.setAside(parentID, null);
      store.upsertSession(s);
      setShown(false);
      o.openSession(s.id);
    } catch (e) {
      toast(`Impossible de garder la question annexe : ${errorMessage(e)}`);
    }
  };

  const busy = createComputed(() => {
    store.children(); // republié à chaque changement d'activité
    const c = conv();
    return c !== null && store.activity(c.sessionID) !== 'idle';
  });
  const context = createComputed(() => conv()?.context() ?? null);

  const send = async (fn: (id: string) => Promise<void>): Promise<boolean> => {
    try {
      await fn(await create());
      return true;
    } catch (e) {
      toast(`Question annexe impossible : ${errorMessage(e)}`);
      return false;
    }
  };
  const composer = Composer({
    busy,
    initial: o.initial,
    loadChoices: o.loadChoices,
    send: (text, choice, payload) => send((id) => client.prompt(id, o.dir(), text, { ...payload, ...choice })),
    loadCommands: () => client.commands(o.dir()),
    runCommand: (name, args, choice, payload) => send((id) => client.command(id, o.dir(), name, args, { ...payload, ...choice })),
    builtins: [],
    findFiles: o.findFiles,
    history: () => conv.peek()?.userMessages().map((m) => m.text) ?? [],
    toast,
    context,
    abort: () => {
      const id = conv.peek()?.sessionID;
      if (id !== undefined) client.abort(id, o.dir()).catch((e: unknown) => toast(`Interruption impossible : ${errorMessage(e)}`));
    },
  });

  // la session principale a avancé depuis le fork : contexte en retard
  const late = createComputed(() => {
    const r = ref();
    const s = o.parent();
    return r !== null && s !== null && (s.time.updated ?? s.time.created) > r.at + 2000;
  });
  const status = createComputed(() => {
    const parts: string[] = [];
    const c = context();
    if (c !== null && c.cacheRead > 0) parts.push(`${fmt(c.cacheRead)} tokens lus en cache`);
    if (late()) parts.push('la session a avancé depuis : « Actualiser le contexte » pour repartir de son état actuel');
    return parts.join(' · ');
  });
  const has = ref((r) => r !== null);

  const widget = (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} cssClasses={['aside-panel']} widthRequest={320}>
      <Gtk.Box cssClasses={['aside-header']} spacing={4} marginStart={12} marginEnd={6} marginTop={6} marginBottom={6}>
        <Gtk.Label label={ASIDE_TITLE} hexpand xalign={0} cssClasses={['heading']} />
        <Gtk.Button
          iconName="view-refresh-symbolic"
          tooltipText="Actualiser le contexte : supprime cet échange, la prochaine question repart de l'état actuel de la session"
          sensitive={has}
          cssClasses={['flat']}
          onClicked={() => void remove()}
        />
        <Gtk.Button
          iconName="document-save-symbolic"
          tooltipText="Garder comme session (visible dans la barre latérale)"
          sensitive={has}
          cssClasses={['flat']}
          onClicked={() => void keep()}
        />
        <Gtk.Button iconName="user-trash-symbolic" tooltipText="Supprimer la question annexe" sensitive={has} cssClasses={['flat']} onClicked={() => void remove()} />
        <Gtk.Button iconName="window-close-symbolic" tooltipText="Fermer le panneau (Ctrl+Maj+A)" cssClasses={['flat']} onClicked={() => setShown(false)} />
      </Gtk.Box>
      <Gtk.Separator />
      {body}
      <Gtk.Label label={status} visible={status((t) => t !== '')} wrap xalign={0} marginStart={12} marginEnd={12} marginTop={4} cssClasses={['dim-label', 'caption']} />
      {composer}
    </Gtk.Box>
  );
  if (!(widget instanceof Gtk.Widget)) throw new TypeError('widget attendu');

  // contenu chargé à la première ouverture du panneau ; fork supprimé ailleurs : oublié
  let checked = false;
  const open = (): void => {
    const r = ref.peek();
    load(r?.id ?? null);
    if (r === null || checked) return;
    checked = true;
    client.session(r.id).catch((e: unknown) => {
      if (e instanceof HttpError && e.status === 404) {
        settings.setAside(parentID, null);
        load(null);
      }
    });
  };
  const unsubscribe = shown.subscribe(() => {
    if (shown.peek()) open();
  });

  return {
    widget,
    shown,
    toggle: () => setShown(!shown.peek()),
    dispose: () => {
      unsubscribe();
      disposeView?.();
      conv.peek()?.dispose();
    },
  };
}
