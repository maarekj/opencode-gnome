// Fenêtre principale : projets (barre latérale) -> sessions du projet, synchronisés en direct.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createComputed, createMemo, createState, onCleanup, With, type Accessor } from 'gnim';
import { errorMessage } from '../shared/errors.ts';
import { esc, fmtCost, fmtRelative } from '../shared/format.ts';
import type { Session } from '../shared/schemas.ts';
import { prettyPath, type ProjectView, type SessionView, type Store } from '../shared/store.ts';
import { attachCommand, openTerminal } from '../shared/terminal.ts';
import { createConversationPage, sessionTag, type ConversationPageHandle } from './ConversationPage.tsx';
import type { Settings } from '../shared/settings.ts';
import { attachContextMenu } from './ContextMenu.ts';
import { keyedListBox } from './KeyedBox.ts';
import { askDelete, askRename, attachSessionMenu, type SessionActions } from './SessionMenu.ts';

export const SERVER_UNIT = 'opencode-gnome-server.service';

interface Actions {
  toast: (message: string) => void;
  /** Ouvre opencode dans un terminal : sur une session, ou une nouvelle si `sessionID` est absent. */
  attach: (directory: string, sessionID?: string) => void;
  /** Affiche la conversation d'une session. */
  openSession: (sessionID: string) => void;
  /** Crée une session dans un répertoire et l'ouvre. */
  newSession: (directory: string) => void;
  /** Actions du menu d'une session (ouvrir, terminal, renommer, forker, supprimer). */
  sessionActions: (session: Session) => SessionActions;
  /** Ferme une session ouverte (retirée de la barre latérale). */
  closeSession: (sessionID: string) => void;
}

// ---------------------------------------------------------------- barre latérale

const plural = (n: number, one: string, many: string): string => `${n} ${n > 1 ? many : one}`;

/**
 * Projet de la barre latérale. Suffixes : spinner si l'agent travaille dans une session,
 * pastille orange avec le nombre de sessions qui attendent une réponse. Projets vides atténués.
 */
interface ProjectActions {
  /** affiche la liste complète des sessions du projet */
  showList: (key: string) => void;
  /** ouvre une session (onglet) */
  openSession: (sessionID: string) => void;
  /** ferme une session ouverte */
  closeSession: (sessionID: string) => void;
  /** déplie / replie un projet */
  toggle: (key: string) => void;
  sessionActions: (session: Session) => SessionActions;
  isFavorite: (path: string) => boolean;
  toggleFavorite: (path: string) => void;
  newSession: (directory: string) => void;
  /** opencode dans un terminal, nouvelle session */
  attach: (directory: string) => void;
}

function ProjectRow({
  project,
  favorite,
  open,
  expanded,
  actions,
}: {
  project: ProjectView;
  favorite: boolean;
  /** nombre de sessions ouvertes du projet */
  open: number;
  expanded: boolean;
  actions: ProjectActions;
}): JSX.Element {
  const empty = project.sessions.length === 0;
  // replié (ou sans session ouverte) : résumé d'activité sur la ligne du projet
  const summary = !expanded || open === 0;
  return (
    <Adw.ActionRow
      name={`p:${project.key}`}
      title={esc(project.name)}
      subtitle={esc(prettyPath(project.path))}
      subtitleLines={1}
      activatable
      cssClasses={empty ? ['project-row', 'dim-label'] : ['project-row']}
      tooltipText={empty ? 'Aucune session' : ''}
      $={(self: Adw.ActionRow) => {
        attachContextMenu(self, () => [
          [
            { label: 'Toutes les sessions…', activate: () => actions.showList(project.key) },
            { label: actions.isFavorite(project.path) ? 'Retirer des favoris' : 'Ajouter aux favoris', activate: () => actions.toggleFavorite(project.path) },
          ],
          [
            { label: 'Nouvelle session', activate: () => actions.newSession(project.path) },
            { label: 'Ouvrir opencode dans le terminal', activate: () => actions.attach(project.path) },
          ],
        ]);
      }}
    >
      {/* add_prefix insère en tête : l'icône est déclarée avant la flèche pour être à sa droite */}
      <Gtk.Image $type="prefix" iconName={expanded && open > 0 ? 'folder-open-symbolic' : 'folder-symbolic'} />
      {open > 0 ? (
        <Gtk.Button
          $type="prefix"
          iconName={expanded ? 'pan-down-symbolic' : 'pan-end-symbolic'}
          tooltipText={expanded ? 'Replier' : 'Déplier'}
          valign={Gtk.Align.CENTER}
          cssClasses={['flat', 'circular', 'expander-button']}
          onClicked={() => actions.toggle(project.key)}
        />
      ) : (
        <Gtk.Box $type="prefix" widthRequest={24} />
      )}
      {project.working > 0 && summary ? <Adw.Spinner $type="suffix" tooltipText={plural(project.working, 'session en cours', 'sessions en cours')} /> : null}
      {project.waiting > 0 && summary ? (
        <Gtk.Label
          $type="suffix"
          label={String(project.waiting)}
          valign={Gtk.Align.CENTER}
          cssClasses={['waiting-badge']}
          tooltipText={plural(project.waiting, 'session attend ta réponse', 'sessions attendent ta réponse')}
        />
      ) : null}
      <Gtk.Button
        $type="suffix"
        iconName={favorite ? 'starred-symbolic' : 'non-starred-symbolic'}
        tooltipText={favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
        valign={Gtk.Align.CENTER}
        cssClasses={favorite ? ['flat', 'star', 'favorite'] : ['flat', 'star']}
        onClicked={() => actions.toggleFavorite(project.path)}
      />
    </Adw.ActionRow>
  );
}

/** Session ouverte, sous son projet : titre, activité, fermeture (×) au survol, menu contextuel. */
function SessionTreeRow({ view, actions }: { view: SessionView; actions: ProjectActions }): JSX.Element {
  const s = view.session;
  const title = s.title === '' ? 'Sans titre' : s.title;
  const act = actions.sessionActions(s);
  return (
    <Gtk.ListBoxRow
      name={`s:${s.id}`}
      cssClasses={['session-tree-row']}
      tooltipText={title}
      $={(self: Gtk.ListBoxRow) => {
        attachContextMenu(self, () => [
          [
            { label: 'Ouvrir dans le terminal', activate: act.openInTerminal },
            { label: 'Renommer…', activate: () => askRename(self, title, act.rename) },
            { label: 'Forker', activate: act.fork },
          ],
          [{ label: 'Fermer', activate: () => actions.closeSession(s.id) }],
          [{ label: 'Supprimer…', activate: () => askDelete(self, title, act.delete) }],
        ]);
      }}
    >
      <Gtk.Box spacing={8} marginStart={44} marginEnd={4} marginTop={2} marginBottom={2}>
        <Gtk.Box widthRequest={16} valign={Gtk.Align.CENTER}>
          {treeActivity(view)}
        </Gtk.Box>
        <Gtk.Label label={title} hexpand xalign={0} ellipsize={Pango.EllipsizeMode.END} />
        <Gtk.Button
          iconName="window-close-symbolic"
          tooltipText="Fermer (Ctrl+W)"
          valign={Gtk.Align.CENTER}
          cssClasses={['flat', 'circular', 'close-button']}
          onClicked={() => actions.closeSession(s.id)}
        />
      </Gtk.Box>
    </Gtk.ListBoxRow>
  );
}

/** Indicateur d'activité compact d'une session de l'arbre. */
function treeActivity(view: SessionView): JSX.Element {
  switch (view.activity) {
    case 'busy':
      return <Adw.Spinner tooltipText="En cours" />;
    case 'retry':
      return <Gtk.Image iconName="view-refresh-symbolic" cssClasses={['warning']} tooltipText="Nouvel essai" />;
    case 'question':
      return <Gtk.Image iconName="help-about-symbolic" cssClasses={['warning']} tooltipText="Question en attente" />;
    case 'permission':
      return <Gtk.Image iconName="dialog-warning-symbolic" cssClasses={['warning']} tooltipText="Permission demandée" />;
    case 'idle':
      return <Gtk.Image iconName="chat-message-new-symbolic" cssClasses={['dim-label']} />;
    default:
      return <Gtk.Box />;
  }
}

/** Élément de l'arbre aplati : un projet, ou une de ses sessions ouvertes. */
type TreeItem =
  | { readonly kind: 'project'; readonly project: ProjectView; readonly favorite: boolean; readonly open: number; readonly expanded: boolean }
  | { readonly kind: 'session'; readonly view: SessionView };

const treeKey = (i: TreeItem): string =>
  i.kind === 'project'
    ? `p|${i.project.key}|${i.project.working}|${i.project.waiting}|${i.project.sessions.length === 0}|${i.project.name}|${i.favorite}|${i.open}|${i.expanded}`
    : `s|${i.view.session.id}|${i.view.activity}|${i.view.session.title}`;

function startServer(): void {
  try {
    Gio.Subprocess.new(['systemctl', '--user', 'start', SERVER_UNIT], Gio.SubprocessFlags.NONE);
  } catch (e) {
    console.error(errorMessage(e));
  }
}

function Sidebar({
  store,
  settings,
  projects,
  select,
  actions,
  shown,
}: {
  store: Store;
  settings: Settings;
  projects: Accessor<readonly ProjectView[]>;
  select: (key: string) => void;
  actions: ProjectActions;
  /** ligne à mettre en évidence : `s:<session affichée>` ou `p:<projet>` */
  shown: Accessor<string>;
}): JSX.Element {
  const conn = store.connection;
  const mode = settings.data((d) => d.sidebarMode);
  const favorites = settings.data((d) => d.favorites);
  const emptyFavorites = createComputed(() => mode() === 'favorites' && projects().length === 0);
  return (
    <Adw.NavigationPage title="Projets" tag="projects">
      <Adw.ToolbarView>
        <Adw.HeaderBar $type="top">
          <Adw.ToggleGroup
            $type="title"
            cssClasses={['round']}
            $={(self: Adw.ToggleGroup) => {
              self.add(new Adw.Toggle({ name: 'favorites', label: 'Favoris', tooltip: 'Projets favoris' }));
              self.add(new Adw.Toggle({ name: 'all', label: 'Tous', tooltip: 'Tous les projets' }));
              self.activeName = mode.peek();
              self.connect('notify::active-name', () => {
                const name = self.activeName;
                if (name === 'favorites' || name === 'all') settings.setSidebarMode(name);
              });
              onCleanup(
                mode.subscribe(() => {
                  if (self.activeName !== mode.peek()) self.activeName = mode.peek();
                }),
              );
            }}
          />
          <Gtk.MenuButton
            $type="start"
            iconName="open-menu-symbolic"
            tooltipText="Menu principal"
            primary
            $={(self: Gtk.MenuButton) => {
              const menu = new Gio.Menu();
              menu.append('Préférences', 'app.preferences');
              self.menuModel = menu;
            }}
          />
          <Gtk.Button $type="end" iconName="view-refresh-symbolic" tooltipText="Recharger" onClicked={() => void store.reload()} />
        </Adw.HeaderBar>
        <Adw.Banner
          $type="top"
          revealed={conn((c) => c.state === 'error')}
          title={conn((c) => (c.state === 'error' ? `Serveur opencode injoignable : ${c.message}` : ''))}
          buttonLabel="Démarrer"
          onButtonClicked={startServer}
        />
        <Gtk.Stack visibleChildName={emptyFavorites((e) => (e ? 'empty' : 'list'))}>
          <Gtk.ScrolledWindow name="list" $type="named" vexpand hscrollbarPolicy={Gtk.PolicyType.NEVER}>
            <Gtk.ListBox
              cssClasses={['navigation-sidebar']}
              onRowActivated={(_self: Gtk.ListBox, row: Gtk.ListBoxRow) => {
                const name = row.name;
                if (name.startsWith('s:')) actions.openSession(name.slice(2));
                else if (name.startsWith('p:')) select(name.slice(2));
              }}
              $={(self: Gtk.ListBox) => {
                // arbre aplati : chaque projet, puis ses sessions ouvertes (ordre d'ouverture) s'il est déplié
                const items = createComputed((): TreeItem[] => {
                  const { openSessions, collapsed } = settings.data();
                  const favs = favorites();
                  const out: TreeItem[] = [];
                  for (const p of projects()) {
                    const byID = new Map(p.sessions.map((v) => [v.session.id, v]));
                    const open = openSessions.flatMap((id) => {
                      const v = byID.get(id);
                      return v === undefined ? [] : [v];
                    });
                    const expanded = !collapsed.includes(p.key);
                    out.push({ kind: 'project', project: p, favorite: favs.includes(p.path), open: open.length, expanded });
                    if (expanded) for (const view of open) out.push({ kind: 'session', view });
                  }
                  return out;
                });
                onCleanup(
                  keyedListBox(self, items, treeKey, (i) =>
                    asWidget(i.kind === 'project' ? ProjectRow({ project: i.project, favorite: i.favorite, open: i.open, expanded: i.expanded, actions }) : SessionTreeRow({ view: i.view, actions })),
                  ),
                );
                // la ligne affichée est sélectionnée (y compris après reconstruction d'une ligne)
                const highlight = (): void => {
                  const name = shown.peek();
                  let target: Gtk.ListBoxRow | null = null;
                  for (let i = 0, row = self.get_row_at_index(0); row !== null; i += 1, row = self.get_row_at_index(i)) {
                    if (row.name === name) target = row;
                  }
                  if (target === null) self.unselect_all();
                  else if (self.get_selected_row() !== target) self.select_row(target);
                };
                highlight();
                onCleanup(shown.subscribe(highlight));
                onCleanup(items.subscribe(highlight));
              }}
            />
          </Gtk.ScrolledWindow>
          <Adw.StatusPage
            name="empty"
            $type="named"
            iconName="starred-symbolic"
            title="Aucun favori"
            description="Ajoute un projet aux favoris avec son étoile (mode « Tous ») ou par clic droit."
            cssClasses={['compact']}
          >
            <Gtk.Button label="Voir tous les projets" halign={Gtk.Align.CENTER} cssClasses={['pill']} onClicked={() => settings.setSidebarMode('all')} />
          </Adw.StatusPage>
        </Gtk.Stack>
      </Adw.ToolbarView>
    </Adw.NavigationPage>
  );
}

// ---------------------------------------------------------------- sessions

const updatedAt = (v: SessionView): number => v.session.time.updated ?? v.session.time.created;

function activityIcon(view: SessionView): JSX.Element | null {
  switch (view.activity) {
    case 'busy':
      return <Adw.Spinner $type="prefix" tooltipText="En cours" />;
    case 'retry':
      return <Gtk.Image $type="prefix" iconName="view-refresh-symbolic" cssClasses={['warning']} tooltipText="Nouvel essai" />;
    case 'question':
      return <Gtk.Image $type="prefix" iconName="help-about-symbolic" cssClasses={['warning']} tooltipText="Question en attente" />;
    case 'permission':
      return <Gtk.Image $type="prefix" iconName="dialog-warning-symbolic" cssClasses={['warning']} tooltipText="Permission demandée" />;
    case 'idle':
      return null;
    default:
      return null;
  }
}

function SessionRow({ view, actions }: { view: SessionView; actions: Actions }): JSX.Element {
  const s = view.session;
  const title = s.title === '' ? 'Sans titre' : s.title;
  const meta = [fmtRelative(updatedAt(view)), s.agent, s.model === undefined ? undefined : s.model.variant === undefined || s.model.variant === 'default' ? s.model.id : `${s.model.id} (${s.model.variant})`, fmtCost(s.cost)].filter((x) => x !== undefined && x !== '').join('  ·  ');
  const act = actions.sessionActions(s);
  return (
    <Adw.ActionRow
      title={esc(title)}
      subtitle={esc(meta)}
      activatable
      onActivated={act.open}
      $={(self: Adw.ActionRow) => {
        attachSessionMenu(self, () => title, act);
      }}
    >
      {activityIcon(view)}
      <Gtk.Box $type="suffix" spacing={2} valign={Gtk.Align.CENTER}>
        <Gtk.Button iconName="utilities-terminal-symbolic" tooltipText="Ouvrir dans le terminal" cssClasses={['flat']} onClicked={act.openInTerminal} />
        <Gtk.Button
          iconName="user-trash-symbolic"
          tooltipText="Supprimer"
          cssClasses={['flat']}
          onClicked={(self: Gtk.Button) => askDelete(self, title, act.delete)}
        />
      </Gtk.Box>
    </Adw.ActionRow>
  );
}

function SessionList({ sessions, actions }: { sessions: Accessor<readonly SessionView[]>; actions: Actions }): JSX.Element {
  // Ordre exact du store (date de mise à jour décroissante). La clé inclut ce qui est affiché :
  // une session modifiée est reconstruite et replacée à sa nouvelle position.
  return (
    <Gtk.ScrolledWindow vexpand hscrollbarPolicy={Gtk.PolicyType.NEVER}>
      <Adw.Clamp maximumSize={900} marginTop={12} marginBottom={12} marginStart={12} marginEnd={12}>
        <Gtk.ListBox
          cssClasses={['boxed-list']}
          selectionMode={Gtk.SelectionMode.NONE}
          valign={Gtk.Align.START}
          $={(self: Gtk.ListBox) => {
            onCleanup(
              keyedListBox(
                self,
                sessions,
                (v) => `${v.session.id}|${updatedAt(v)}|${v.activity}|${v.session.title}`,
                (v) => asWidget(SessionRow({ view: v, actions })),
              ),
            );
          }}
        />
      </Adw.Clamp>
    </Gtk.ScrolledWindow>
  );
}

function asWidget(o: JSX.Element): Gtk.Widget {
  if (!(o instanceof Gtk.Widget)) throw new TypeError('widget attendu');
  return o;
}

function SessionsPage({ store, current, actions }: { store: Store; current: Accessor<ProjectView | null>; actions: Actions }): JSX.Element {
  const key = createMemo(() => current()?.key ?? null);
  const sessions = createComputed(() => current()?.sessions ?? []);
  const empty = createMemo(() => sessions().length === 0);
  const newSession = (): void => {
    const p = current();
    if (p !== null) actions.newSession(p.path);
  };
  return (
    <Adw.NavigationPage title={current((p) => p?.name ?? 'opencode')} tag="sessions">
      <Adw.ToolbarView>
        <Adw.HeaderBar $type="top">
          <Adw.WindowTitle $type="title" title={current((p) => p?.name ?? 'opencode')} subtitle={current((p) => (p === null ? '' : prettyPath(p.path)))} />
          <Gtk.Button $type="end" iconName="tab-new-symbolic" tooltipText="Nouvelle session" sensitive={key((k) => k !== null)} onClicked={newSession} />
        </Adw.HeaderBar>
        <With value={createMemo(() => `${key() ?? ''}|${String(empty())}|${store.connection().state}`)}>
          {() => {
            if (store.connection.peek().state !== 'connected' && store.projects.peek().length === 0) {
              return <Adw.StatusPage iconName="network-offline-symbolic" title="Connexion au serveur opencode…" description={esc(store.client.url)} vexpand />;
            }
            if (key.peek() === null) return <Adw.StatusPage iconName="folder-symbolic" title="Aucun projet" description="Lance opencode dans un répertoire pour commencer." vexpand />;
            if (empty.peek()) {
              return (
                <Adw.StatusPage iconName="chat-bubbles-empty-symbolic" title="Aucune session" vexpand>
                  <Gtk.Button label="Nouvelle session" halign={Gtk.Align.CENTER} cssClasses={['pill', 'suggested-action']} onClicked={newSession} />
                </Adw.StatusPage>
              );
            }
            return <SessionList sessions={sessions} actions={actions} />;
          }}
        </With>
      </Adw.ToolbarView>
    </Adw.NavigationPage>
  );
}

// ---------------------------------------------------------------- fenêtre

function asPage(o: JSX.Element): Adw.NavigationPage {
  if (!(o instanceof Adw.NavigationPage)) throw new TypeError('NavigationPage attendue');
  return o;
}

export interface WindowApi {
  openSession: (sessionID: string) => void;
  /** ferme la session affichée (Ctrl+W) */
  closeCurrent: () => void;
}

export function MainWindow({
  app,
  store,
  settings,
  size,
  ready,
}: {
  app: Adw.Application;
  store: Store;
  settings: Settings;
  size?: [number, number];
  ready: (api: WindowApi) => void;
}): JSX.Element {
  const [selected, setSelected] = createState<string | null>(null);
  /** Projets connus + favoris absents de la liste d'opencode (répertoire sans session). */
  const allProjects = createComputed((): readonly ProjectView[] => {
    const projects = store.projects();
    const known = new Set(projects.map((p) => p.path));
    const missing = settings
      .data()
      .favorites.filter((path) => !known.has(path))
      .map((path): ProjectView => ({ key: `dir:${path}`, name: GLib.path_get_basename(path), path, vcs: false, sessions: [], working: 0, waiting: 0, updated: 0 }));
    return [...projects, ...missing];
  });
  /** Projets affichés dans la barre latérale selon le mode. */
  const visibleProjects = createComputed((): readonly ProjectView[] => {
    const { sidebarMode, favorites } = settings.data();
    const all = allProjects();
    return sidebarMode === 'all' ? all : all.filter((p) => favorites.includes(p.path));
  });
  const current = createComputed(() => {
    const key = selected();
    return allProjects().find((p) => p.key === key) ?? visibleProjects()[0] ?? allProjects()[0] ?? null;
  });

  let overlay: Adw.ToastOverlay | null = null;
  let split: Adw.NavigationSplitView | null = null;
  // pas d'animation : une session s'affiche immédiatement
  const nav = new Adw.NavigationView({ animateTransitions: false });
  /** pages des sessions ouvertes, conservées (état du prompt, défilement…) */
  const pages = new Map<string, ConversationPageHandle>();
  const disposePage = (sessionID: string): void => {
    const handle = pages.get(sessionID);
    if (handle === undefined) return;
    pages.delete(sessionID);
    if (nav.find_page(sessionTag(sessionID)) !== null) nav.pop_to_tag('sessions');
    handle.dispose();
  };

  const toast = (title: string): void => {
    overlay?.add_toast(new Adw.Toast({ title: esc(title), timeout: 4 }));
  };
  /** Exécute une action serveur ; en cas d'échec, affiche l'erreur. */
  const run = (what: string, fn: () => Promise<void>): void => {
    fn().catch((e: unknown) => {
      toast(`${what} : ${errorMessage(e)}`);
    });
  };

  const actions: Actions = {
    toast,
    attach: (directory, sessionID) => {
      try {
        const { terminal, terminalCommand } = settings.data.peek();
        openTerminal(attachCommand(store.client.url, directory, sessionID), GLib.file_test(directory, GLib.FileTest.IS_DIR) ? directory : GLib.get_home_dir(), {
          terminal,
          command: terminalCommand,
        });
      } catch (e) {
        actions.toast(errorMessage(e));
      }
    },
    sessionActions: (session) => ({
      open: () => actions.openSession(session.id),
      openInTerminal: () => actions.attach(session.directory, session.id),
      rename: (title) =>
        run('Renommage impossible', async () => {
          store.upsertSession(await store.client.renameSession(session.id, session.directory, title));
        }),
      fork: () =>
        run('Fork impossible', async () => {
          const copy = await store.client.forkSession(session.id, session.directory);
          store.upsertSession(copy);
          actions.openSession(copy.id);
          actions.toast('Session forkée');
        }),
      delete: () =>
        run('Suppression impossible', async () => {
          await store.client.deleteSession(session.id, session.directory);
          if (nav.find_page(sessionTag(session.id)) !== null) nav.pop_to_tag('sessions');
          settings.closeSessions([session.id]);
          disposePage(session.id);
          store.removeSession(session.id);
          actions.toast('Session supprimée');
        }),
    }),
    closeSession: (sessionID) => {
      const shownTag = nav.visiblePage?.tag ?? '';
      settings.closeSessions([sessionID]);
      disposePage(sessionID);
      if (shownTag !== sessionTag(sessionID)) return;
      // session affichée : une autre session ouverte du même projet, sinon la liste du projet
      const project = store.projects.peek().find((p) => p.sessions.some((v) => v.session.id === sessionID));
      const ids = new Set(project?.sessions.map((v) => v.session.id) ?? []);
      const next = settings.data.peek().openSessions.findLast((id) => ids.has(id));
      if (next === undefined) nav.pop_to_tag('sessions');
      else actions.openSession(next);
    },
    newSession: (directory) => {
      const create = async (): Promise<void> => {
        try {
          const session = await store.client.createSession(directory);
          store.upsertSession(session);
          actions.openSession(session.id);
        } catch (e) {
          actions.toast(`Création impossible : ${errorMessage(e)}`);
        }
      };
      void create();
    },
    openSession: (sessionID) => {
      const project = store.projects.peek().find((p) => p.sessions.some((v) => v.session.id === sessionID));
      if (project !== undefined) {
        setSelected(project.key);
        settings.setCollapsed(project.key, false);
      }
      settings.openSession(sessionID);
      if (split !== null) split.showContent = true;
      let handle = pages.get(sessionID);
      if (handle === undefined) {
        handle = createConversationPage({ store, settings, sessionID, attach: actions.attach, toast: actions.toast, newSession: actions.newSession, sessionActions: actions.sessionActions });
        pages.set(sessionID, handle);
      }
      if (nav.visiblePage === handle.page) return;
      // pile : liste du projet, puis la session (la page précédente est retirée mais conservée)
      const root = nav.find_page('sessions');
      nav.replace(root === null ? [handle.page] : [root, handle.page]);
    },
  };


  /**
   * Dernière vue de chaque projet : session ouverte (id) ou liste (null). Mise à jour à chaque
   * changement de page, sauf pendant un changement de projet (qui passe brièvement par la liste).
   */
  const lastView = new Map<string, string | null>();
  let switching = false;
  nav.connect('notify::visible-page', () => {
    const key = current.peek()?.key;
    if (switching || key === undefined) return;
    const tag = nav.visiblePage?.tag ?? '';
    lastView.set(key, tag.startsWith('session:') ? tag.slice('session:'.length) : null);
  });

  const select = (key: string): void => {
    if (split !== null) split.showContent = true;
    // projet déjà affiché : retour à sa liste de sessions
    if (key === current.peek()?.key) {
      nav.pop_to_tag('sessions');
      return;
    }
    // autre projet : restaure sa dernière vue, si la session existe encore
    const sessionID = lastView.get(key) ?? null;
    const exists = sessionID !== null && store.projects.peek().some((p) => p.key === key && p.sessions.some((v) => v.session.id === sessionID));
    switching = true;
    setSelected(key);
    nav.pop_to_tag('sessions');
    switching = false;
    if (exists) actions.openSession(sessionID);
  };

  nav.add(asPage(SessionsPage({ store, current, actions })));
  ready({ openSession: actions.openSession, closeCurrent: () => {
    const tag = nav.visiblePage?.tag ?? '';
    if (tag.startsWith('session:')) actions.closeSession(tag.slice('session:'.length));
  } });

  /** Ligne mise en évidence dans la barre latérale : session affichée, sinon projet courant. */
  const [shown, setShown] = createState('');
  const updateShown = (): void => {
    const tag = nav.visiblePage?.tag ?? '';
    setShown(tag.startsWith('session:') ? `s:${tag.slice('session:'.length)}` : `p:${current.peek()?.key ?? ''}`);
  };
  nav.connect('notify::visible-page', updateShown);
  onCleanup(current.subscribe(updateShown));

  // sessions ouvertes qui n'existent plus (supprimées ailleurs) : retirées, une fois chargées
  onCleanup(
    store.projects.subscribe(() => {
      if (store.connection.peek().state !== 'connected') return;
      const known = new Set(store.projects.peek().flatMap((p) => p.sessions.map((v) => v.session.id)));
      const gone = settings.data.peek().openSessions.filter((id) => !known.has(id));
      if (gone.length > 0) {
        settings.closeSessions(gone);
        for (const id of gone) disposePage(id);
      }
    }),
  );

  return (
    <Adw.ApplicationWindow application={app} title="opencode" defaultWidth={size?.[0] ?? 1100} defaultHeight={size?.[1] ?? 720}>
      <Adw.ToastOverlay
        $={(self: Adw.ToastOverlay) => {
          overlay = self;
        }}
      >
        <Adw.NavigationSplitView
          sidebarWidthFraction={0.28}
          minSidebarWidth={240}
          maxSidebarWidth={340}
          sidebar={asPage(
            Sidebar({
              store,
              settings,
              projects: visibleProjects,
              select,
              shown,
              actions: {
                showList: (key) => {
                  select(key);
                  nav.pop_to_tag('sessions');
                },
                openSession: (id) => actions.openSession(id),
                closeSession: (id) => actions.closeSession(id),
                toggle: (key) => settings.setCollapsed(key, !settings.data.peek().collapsed.includes(key)),
                sessionActions: (session) => actions.sessionActions(session),
                isFavorite: (path) => settings.isFavorite(path),
                toggleFavorite: (path) => settings.toggleFavorite(path),
                newSession: (dir) => actions.newSession(dir),
                attach: (dir) => actions.attach(dir),
              },
            }),
          )}
          content={new Adw.NavigationPage({ title: 'opencode', child: nav })}
          $={(self: Adw.NavigationSplitView) => {
            split = self;
          }}
        />
      </Adw.ToastOverlay>
      <Adw.Breakpoint
        $={(self: Adw.Breakpoint) => {
          self.set_condition(Adw.BreakpointCondition.parse('max-width: 600sp'));
          if (split !== null) self.add_setter(split, 'collapsed', true);
        }}
      />
    </Adw.ApplicationWindow>
  );
}
