// Page « conversation » d'une session, poussée dans le NavigationView du panneau principal.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { createComputed, createMemo, createRoot, createState } from 'gnim';
import { Conversation } from '../shared/conversation.ts';
import type { Settings } from '../shared/settings.ts';
import { prettyPath, type Activity, type Store } from '../shared/store.ts';
import { errorMessage } from '../shared/errors.ts';
import { gitStatus, type GitStatus } from '../shared/git.ts';
import type { Session } from '../shared/schemas.ts';
import { builtinCommands } from './Builtins.ts';
import { Composer } from './Composer.tsx';
import { IdeButton } from './Ide.ts';
import { LinkBar } from './LinkBar.tsx';
import { openFolder } from './OpenFolder.ts';
import type { SessionActions } from './SessionMenu.ts';
import { ConversationView } from './ConversationView.tsx';
import { openGitWindow } from './GitWindow.tsx';
import type { RequestActions } from './Requests.tsx';
import { TerminalBar, type TerminalContext } from './TerminalBar.tsx';
import { integratedAvailable } from './TerminalPanel.tsx';
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

/** « ⎇ agent-3 (worktree) · ↑2 ↓1 · 3 modifiés » */
export function gitSummary(g: GitStatus): string {
  const head = g.branch === null ? `⎇ ${g.commit} (détachée)` : `⎇ ${g.branch}`;
  const sync = [g.ahead > 0 ? `↑${g.ahead}` : '', g.behind > 0 ? `↓${g.behind}` : ''].filter((x) => x !== '').join(' ');
  return [
    g.mainWorktree === null ? head : `${head} (worktree)`,
    sync,
    g.changes === 0 ? '' : `${g.changes} modifié${g.changes > 1 ? 's' : ''}`,
  ]
    .filter((x) => x !== '')
    .join('  ·  ');
}

/** Détail de l'état git (infobulle du titre). */
export function gitTooltip(g: GitStatus): string {
  const lines = [
    g.branch === null ? `HEAD détachée sur ${g.commit}` : `Branche ${g.branch} (${g.commit})`,
    g.upstream === null ? 'Pas de branche amont' : `Amont ${g.upstream} : ${g.ahead} en avance, ${g.behind} en retard`,
    g.mainWorktree === null ? `Dépôt ${prettyPath(g.toplevel)}` : `Worktree ${prettyPath(g.toplevel)}\nDépôt principal ${prettyPath(g.mainWorktree)}`,
    g.changes === 0 ? 'Aucune modification' : `${g.changes} fichier${g.changes > 1 ? 's' : ''} modifié${g.changes > 1 ? 's' : ''} ou non suivi${g.changes > 1 ? 's' : ''}`,
    'Cliquer pour ouvrir la fenêtre git',
  ];
  return lines.join('\n');
}

export const sessionTag = (sessionID: string): string => `session:${sessionID}`;
export const subagentTag = (sessionID: string): string => `subagent:${sessionID}`;

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
  newSession: (directory: string) => void;
  sessionActions: (session: Session) => SessionActions;
  terminals: TerminalContext;
  /** ouvre la conversation d'un sous-agent (au-dessus de cette page) */
  openSubagent: (sessionID: string) => void;
  /** session d'un sous-agent : lecture seule (pas de compositeur ni de terminaux) */
  child?: boolean;
  /** texte pré-rempli dans le compositeur */
  draft?: string;
  /** session d'origine d'un fork : son agent et son modèle sont présélectionnés */
  draftFrom?: Session;
  /** nouvelle session copiée jusqu'à ce message (exclu), le message pré-rempli dans son compositeur */
  forkFrom: (sessionID: string, directory: string, messageID: string, text: string) => void;
}): ConversationPageHandle {
  const { store, settings, sessionID, attach, toast, terminals } = opts;
  const child = opts.child === true;
  return createRoot((dispose) => {
    const conversation = new Conversation(store, sessionID);
    // chargement réseau immédiat (non bloquant) ; widgets construits après l'animation d'entrée
    void conversation.start();
    const [revealed, setRevealed] = createState(false);

    if (child) store.loadChild(sessionID).catch((e: unknown) => toast(`Sous-agent introuvable : ${errorMessage(e)}`));
    const view = createComputed(() => {
      const sub = store.children().get(sessionID);
      if (sub !== undefined) return sub;
      for (const p of store.projects()) {
        const found = p.sessions.find((s) => s.session.id === sessionID);
        if (found !== undefined) return found;
      }
      return null;
    });
    /** racine du projet de la session (terminaux persistants) */
    const projectPath = createMemo(() => store.projects().find((p) => p.sessions.some((s) => s.session.id === sessionID))?.path ?? null);
    const title = view((v) => {
      if (v === null || v.session.title === '') return child ? 'Sous-agent' : 'Session';
      // « Description (@explore subagent) » -> « @explore · Description »
      const m = /^(.*) \(@(\S+) subagent\)$/u.exec(v.session.title);
      return m === null ? v.session.title : `@${m[2] ?? ''} · ${m[1] ?? ''}`;
    });
    // état git du dossier de la session, relu à chaque modification de fichiers, fin de tour ou retour sur la fenêtre
    const [gitState, setGitState] = createState<GitStatus | null>(null);
    let gitLoading = false;
    let gitAgain = false;
    const refreshGit = (): void => {
      const d = conversation.directory ?? view.peek()?.session.directory;
      if (d === undefined) return;
      if (gitLoading) {
        gitAgain = true;
        return;
      }
      gitLoading = true;
      gitStatus(d)
        .then(setGitState)
        .catch((e: unknown) => console.error(e))
        .finally(() => {
          gitLoading = false;
          if (gitAgain) {
            gitAgain = false;
            refreshGit();
          }
        });
    };
    const subtitle = createComputed(() => {
      const g = gitState();
      const git = g === null ? '' : gitSummary(g);
      if (conversation.questions().length > 0) return ACTIVITY_LABEL.question;
      if (conversation.permissions().length > 0) return ACTIVITY_LABEL.permission;
      const v = view();
      if (v === null) return '';
      const base = ACTIVITY_LABEL[v.activity] || (child ? `Sous-agent · ${prettyPath(v.session.directory)}` : prettyPath(v.session.directory));
      return git === '' ? base : `${base}  ·  ${git}`;
    });
    const busy = view((v) => v !== null && v.activity !== 'idle');
    // messages annulés par /undo (ici ou dans la TUI) : masqués jusqu'au prochain prompt
    const revert = view((v) => v?.session.revert?.messageID ?? null);
    conversation.setRevert(revert.peek());
    // subscribe() de gnim n'est pas lié au scope : désabonné explicitement au dispose (#58)
    const unsubscribeRevert = revert.subscribe(() => conversation.setRevert(revert.peek()));
    const client = store.client;
    const dir = (): string => conversation.directory ?? view.peek()?.session.directory ?? GLib.get_home_dir();


    // sous-agent : lecture seule, pas de compositeur (ni chargement des modèles et commandes : #86)
    const composer = child
      ? null
      : Composer({
          busy,
          ...(opts.draft === undefined ? {} : { initialText: opts.draft }),
          initial: () => {
            const own = view.peek()?.session;
            const s = own?.model === undefined && opts.draftFrom !== undefined ? { ...opts.draftFrom, ...(own?.agent === undefined ? {} : { agent: own.agent }) } : own;
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
          send: (text, choice, payload) => attempt(toast, 'Envoi impossible', () => client.prompt(sessionID, dir(), text, { ...payload, ...choice })),
          loadCommands: () => client.commands(dir()),
          runCommand: (name, args, choice, payload) => attempt(toast, `/${name}`, () => client.command(sessionID, dir(), name, args, { ...payload, ...choice })),
          builtins: builtinCommands({
            client,
            sessionID,
            dir,
            session: () => store.session(sessionID) ?? view.peek()?.session,
            userMessages: () => conversation.userMessages(),
            toast,
            newSession: opts.newSession,
            sessionActions: opts.sessionActions,
            attach,
            parent: () => {
              if (!(page instanceof Gtk.Widget)) throw new TypeError('widget attendu');
              return page;
            },
          }),
          findFiles: async (query, cancellable) => {
            // fichiers et dossiers : les dossiers permettent de descendre dans l'arborescence
            const [files, dirs] = await Promise.all([
              client.findFiles(dir(), query, { limit: 20, cancellable }),
              client.findFiles(dir(), query, { type: 'directory', limit: 5, cancellable }),
            ]);
            return query.endsWith('/') ? [...dirs, ...files] : [...files.slice(0, 15), ...dirs, ...files.slice(15)];
          },
          history: () => conversation.userMessages().map((m) => m.text),
          toast,
          context: conversation.context,
          abort: () => void attempt(toast, 'Interruption impossible', () => client.abort(sessionID, dir())),
        });

    /** réponse envoyée, puis demandes relues ; false si l'envoi a échoué */
    const answer = async (send: () => Promise<void>): Promise<boolean> => {
      const ok = await attempt(toast, 'Réponse impossible', send);
      void conversation.reloadRequests();
      return ok;
    };
    const requestActions: RequestActions = {
      replyPermission: (id, reply) => answer(() => client.replyPermission(id, dir(), reply)),
      replyQuestion: (id, answers) => answer(() => client.replyQuestion(id, dir(), answers)),
      rejectQuestion: (id) => answer(() => client.rejectQuestion(id, dir())),
    };

    const showTools = settings.data((d) => d.showTools);
    const openDiff = (self: Gtk.Button): void =>
      openGitWindow(self, {
        directory: dir(),
        title: GLib.path_get_basename(dir()),
        load: () => client.gitDiff(dir()),
        changed: conversation.diffVersion,
      });

    const page = (
      <Adw.NavigationPage title={title} tag={child ? subagentTag(sessionID) : sessionTag(sessionID)}>
        <Adw.ToolbarView>
          <Adw.HeaderBar $type="top">
            <Gtk.Button
              $type="title"
              cssClasses={['flat', 'title-button']}
              tooltipText={gitState((g) => (g === null ? '' : gitTooltip(g)))}
              hasTooltip={gitState((g) => g !== null)}
              sensitive={gitState((g) => g !== null)}
              onClicked={openDiff}
            >
              <Adw.WindowTitle title={title} subtitle={subtitle} />
            </Gtk.Button>
            <Gtk.ToggleButton
              $type="end"
              iconName="applications-engineering-symbolic"
              active={showTools}
              tooltipText={showTools((v) => (v ? "Masquer les appels d'outils (Ctrl+Maj+O)" : "Afficher les appels d'outils (Ctrl+Maj+O)"))}
              onToggled={(self: Gtk.ToggleButton) => settings.setShowTools(self.active)}
            />
            <Gtk.Button
              $type="end"
              iconName="og-git-symbolic"
              tooltipText="Git : modifications, journal, branches"
              onClicked={openDiff}
            />
            <Gtk.Box $type="end" visible={!child}>
              {terminals.dock.toggleButton()}
            </Gtk.Box>
            <Gtk.Button
              $type="end"
              iconName="utilities-terminal-symbolic"
              tooltipText={settings.data((d) => (integratedAvailable() && d.terminalIntegrated ? 'Ouvrir la session dans un terminal (opencode attach)' : 'Ouvrir la session dans le terminal externe (opencode attach)'))}
              onClicked={() => {
                const v = view.peek();
                if (v !== null) attach(v.session.directory, sessionID);
              }}
            />
            <Gtk.Button
              $type="end"
              iconName="folder-open-symbolic"
              tooltipText="Ouvrir le dossier"
              onClicked={(self: Gtk.Button) => openFolder(self, dir(), toast)}
            />
            <Gtk.Box $type="end">{IdeButton({ project: projectPath, settings, toast, directory: dir })}</Gtk.Box>
          </Adw.HeaderBar>
          <Gtk.Box $type="top" visible={!child}>
            <TerminalBar project={projectPath} ctx={terminals} />
            <LinkBar project={projectPath} ctx={{ settings, toast }} directory={dir} />
          </Gtk.Box>
          <ConversationView
            conversation={conversation}
            revealed={revealed}
            actions={requestActions}
            showTools={showTools}
            maxWidth={settings.data((d) => d.maxWidth)}
            fork={child ? undefined : (messageID: string, text: string) => opts.forkFrom(sessionID, dir(), messageID, text)}
            subagents={{
              activity: (id) => store.activity(id),
              // republié à chaque changement de statut / demande (toutes sessions)
              changed: store.children,
              track: (id) => {
                const c = new Conversation(store, id);
                void c.start();
                return c;
              },
              open: opts.openSubagent,
            }}
            emptyClick={() => {
              // zone de saisie du compositeur (premier TextView)
              const find = (w: Gtk.Widget | null): Gtk.TextView | null => {
                for (let c = w; c !== null; c = c.get_next_sibling()) {
                  if (c instanceof Gtk.TextView) return c;
                  const inner = find(c.get_first_child());
                  if (inner !== null) return inner;
                }
                return null;
              };
              if (composer instanceof Gtk.Widget) find(composer.get_first_child())?.grab_focus();
            }}
          />
          <Gtk.Box $type="bottom" orientation={Gtk.Orientation.VERTICAL}>
            <TodoPanel todos={conversation.todos} />
            {composer}
          </Gtk.Box>
        </Adw.ToolbarView>
      </Adw.NavigationPage>
    );
    if (!(page instanceof Adw.NavigationPage)) throw new TypeError('NavigationPage attendue');

    // construction de la conversation au premier affichage seulement (la page est ensuite conservée)
    refreshGit();
    const unsubscribeGit = [conversation.diffVersion.subscribe(refreshGit), busy.subscribe(refreshGit)];
    // retour sur la fenêtre : un commit ou un changement de branche a pu avoir lieu ailleurs
    let activeHandler = 0;
    let activeWindow: Gtk.Window | null = null;
    page.connect('realize', () => {
      const root = page.get_root();
      if (!(root instanceof Gtk.Window) || activeWindow !== null) return;
      activeWindow = root;
      activeHandler = root.connect('notify::is-active', () => {
        if (root.isActive && page.get_mapped()) refreshGit();
      });
    });
    page.connect('shown', () => {
      refreshGit();
      if (revealed.peek()) return;
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, REVEAL_DELAY_MS, () => {
        setRevealed(true);
        return GLib.SOURCE_REMOVE;
      });
    });
    return {
      page,
      dispose: () => {
        for (const u of unsubscribeGit) u();
        unsubscribeRevert();
        if (activeWindow !== null) activeWindow.disconnect(activeHandler);
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
