// Page « conversation » d'une session, poussée dans le NavigationView du panneau principal.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { createComputed, createRoot, createState } from 'gnim';
import { Conversation } from '../shared/conversation.ts';
import type { Settings } from '../shared/settings.ts';
import { prettyPath, type Activity, type Store } from '../shared/store.ts';
import { errorMessage } from '../shared/errors.ts';
import { Composer } from './Composer.tsx';
import { ConversationView } from './ConversationView.tsx';
import { openDiffWindow } from './DiffWindow.tsx';
import type { RequestActions } from './Requests.tsx';
import { TodoPanel } from './TodoPanel.tsx';

const ACTIVITY_LABEL: Readonly<Record<Activity, string>> = {
  idle: '',
  busy: 'En cours…',
  retry: 'Nouvel essai…',
  question: 'Question en attente',
  permission: 'Permission demandée',
};

/**
 * Délai entre l'affichage de la page et la construction de la conversation : laisse le temps de
 * dessiner le spinner (pas d'animation de navigation, cf. MainWindow).
 */
const REVEAL_DELAY_MS = 30;

/** Exécute une action serveur, affiche l'erreur éventuelle. */
async function attempt(toast: (m: string) => void, what: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    toast(`${what} : ${errorMessage(e)}`);
    return false;
  }
}

export const sessionTag = (sessionID: string): string => `session:${sessionID}`;

/**
 * Crée la page d'une session. Elle n'est pas détruite en quittant l'écran : son état (prompt en
 * cours, défilement, choix de modèle) est retrouvé au retour. Libérée par `dispose()`.
 */
export function createConversationPage(opts: {
  store: Store;
  settings: Settings;
  sessionID: string;
  attach: (directory: string, sessionID?: string) => void;
  toast: (message: string) => void;
}): ConversationPageHandle {
  const { store, settings, sessionID, attach, toast } = opts;
  return createRoot((dispose) => {
    const conversation = new Conversation(store, sessionID);
    // chargement réseau immédiat (non bloquant) ; widgets construits après l'animation d'entrée
    void conversation.start();
    const [revealed, setRevealed] = createState(false);

    const view = createComputed(() => {
      for (const p of store.projects()) {
        const found = p.sessions.find((s) => s.session.id === sessionID);
        if (found !== undefined) return found;
      }
      return null;
    });
    const title = view((v) => (v === null || v.session.title === '' ? 'Session' : v.session.title));
    const subtitle = createComputed(() => {
      if (conversation.questions().length > 0) return ACTIVITY_LABEL.question;
      if (conversation.permissions().length > 0) return ACTIVITY_LABEL.permission;
      const v = view();
      return v === null ? '' : ACTIVITY_LABEL[v.activity] || prettyPath(v.session.directory);
    });
    const busy = view((v) => v !== null && v.activity !== 'idle');
    const client = store.client;
    const dir = (): string => conversation.directory ?? view.peek()?.session.directory ?? GLib.get_home_dir();


    const composer = Composer({
      busy,
      initial: () => {
        const s = view.peek()?.session;
        // variante : celle de la session, sinon celle du dernier tour de l'assistant
        const variant = s?.model?.variant ?? conversation.context.peek()?.variant;
        return {
          ...(s?.agent === undefined ? {} : { agent: s.agent }),
          ...(s?.model === undefined ? {} : { model: { providerID: s.model.providerID, modelID: s.model.id } }),
          ...(variant === undefined ? {} : { variant }),
        };
      },
      loadChoices: async () => {
        const [agents, providers, config] = await Promise.all([client.agents(dir()), client.providers(dir()), client.config(dir()).catch(() => null)]);
        const { defaultModel, defaultVariant } = settings.data.peek();
        // modèle d'une session sans modèle : préférence de l'app > config opencode > défaut des fournisseurs
        const defaults = [defaultModel, config?.model ?? undefined].filter((m): m is string => m !== undefined && m !== '');
        return { agents, providers, defaults, ...(defaultModel === undefined || defaultVariant === undefined ? {} : { defaultVariant }) };
      },
      send: (text, choice, files) => attempt(toast, 'Envoi impossible', () => client.prompt(sessionID, dir(), text, { files, ...choice })),
      toast,
      context: conversation.context,
      abort: () => void attempt(toast, 'Interruption impossible', () => client.abort(sessionID, dir())),
    });

    const requestActions: RequestActions = {
      replyPermission: (id, reply) => void attempt(toast, 'Réponse impossible', () => client.replyPermission(id, dir(), reply)).then(() => conversation.reloadRequests()),
      replyQuestion: (id, answers) => void attempt(toast, 'Réponse impossible', () => client.replyQuestion(id, dir(), answers)).then(() => conversation.reloadRequests()),
      rejectQuestion: (id) => void attempt(toast, 'Réponse impossible', () => client.rejectQuestion(id, dir())).then(() => conversation.reloadRequests()),
    };

    const showTools = settings.data((d) => d.showTools);

    const page = (
      <Adw.NavigationPage title={title} tag={sessionTag(sessionID)}>
        <Adw.ToolbarView>
          <Adw.HeaderBar $type="top">
            <Adw.WindowTitle $type="title" title={title} subtitle={subtitle} />
            <Gtk.ToggleButton
              $type="end"
              iconName="applications-engineering-symbolic"
              active={showTools}
              tooltipText={showTools((v) => (v ? "Masquer les appels d'outils (Ctrl+Maj+O)" : "Afficher les appels d'outils (Ctrl+Maj+O)"))}
              onToggled={(self: Gtk.ToggleButton) => settings.setShowTools(self.active)}
            />
            <Gtk.Button
              $type="end"
              iconName="document-edit-symbolic"
              tooltipText="Fichiers modifiés (git)"
              onClicked={(self: Gtk.Button) =>
                openDiffWindow(self, {
                  directory: dir(),
                  title: GLib.path_get_basename(dir()),
                  load: () => client.gitDiff(dir()),
                  vcs: () => client.vcs(dir()),
                  changed: conversation.diffVersion,
                })
              }
            />
            <Gtk.Button
              $type="end"
              iconName="utilities-terminal-symbolic"
              tooltipText="Ouvrir dans le terminal"
              onClicked={() => {
                const v = view.peek();
                if (v !== null) attach(v.session.directory, sessionID);
              }}
            />
          </Adw.HeaderBar>
          <ConversationView conversation={conversation} revealed={revealed} actions={requestActions} showTools={showTools} maxWidth={settings.data((d) => d.maxWidth)} />
          <Gtk.Box $type="bottom" orientation={Gtk.Orientation.VERTICAL}>
            <TodoPanel todos={conversation.todos} />
            {composer}
          </Gtk.Box>
        </Adw.ToolbarView>
      </Adw.NavigationPage>
    );
    if (!(page instanceof Adw.NavigationPage)) throw new TypeError('NavigationPage attendue');

    // construction de la conversation au premier affichage seulement (la page est ensuite conservée)
    page.connect('shown', () => {
      if (revealed.peek()) return;
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, REVEAL_DELAY_MS, () => {
        setRevealed(true);
        return GLib.SOURCE_REMOVE;
      });
    });
    return {
      page,
      dispose: () => {
        conversation.dispose();
        dispose();
      },
    };
  });
}

/** Page d'une session ouverte, conservée en mémoire tant que la session est ouverte. */
export interface ConversationPageHandle {
  readonly page: Adw.NavigationPage;
  /** libère la page (session fermée ou supprimée) */
  readonly dispose: () => void;
}
