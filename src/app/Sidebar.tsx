// Barre latérale : projets (favoris ou tous), sessions ouvertes, terminaux et tâches dessous.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createComputed, createState, onCleanup, type Accessor } from 'gnim';
import { errorMessage } from '../shared/errors.ts';
import { esc } from '../shared/format.ts';
import type { Session } from '../shared/schemas.ts';
import { prettyPath, type ProjectView, type SessionView, type Store } from '../shared/store.ts';
import type { ProjectTerminal, Settings } from '../shared/settings.ts';
import { attachContextMenu, labelMenuButton } from './ContextMenu.ts';
import { openFolder } from './OpenFolder.ts';
import { ideFor, installedIdes, openInIde } from './Ide.ts';
import { keyedListBox } from './KeyedBox.ts';
import { openEditor, taskIcon, taskMenu, taskRunButton, taskState, type EditorContext, type TaskRowContext, type TaskView } from './TasksWindow.tsx';
import { describeSchedule } from '../shared/tasks.ts';
import { TerminalTreeRow, terminalActions, type TerminalContext } from './TerminalBar.tsx';
import { askDelete, askRename, type SessionActions } from './SessionMenu.ts';
import { intercepted } from '../shared/sandbox.ts';

export const SERVER_UNIT = 'opencode-gnome-server.service';

// ---------------------------------------------------------------- barre latérale

export const plural = (n: number, one: string, many: string): string => `${n} ${n > 1 ? many : one}`;

/**
 * Projet de la barre latérale. Suffixes : spinner si l'agent travaille dans une session,
 * pastille orange avec le nombre de sessions qui attendent une réponse. Projets vides atténués.
 */
export interface ProjectActions {
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
  /** dialogue « MCP et skills » du projet */
  extensions: (from: Gtk.Widget, path: string) => void;
  /** relit opencode.json, agents, commandes, skills et MCP du projet */
  reloadConfig: (from: Gtk.Widget, project: ProjectView) => void;
  toggleFavorite: (path: string) => void;
  newSession: (directory: string) => void;
  /** opencode dans un terminal, nouvelle session */
  attach: (directory: string) => void;
  toast: (message: string) => void;
  /** tâches planifiées : édition, suppression (contexte de l'éditeur), fenêtre des tâches */
  tasks: EditorContext;
  openTasksWindow: (page: 'tasks' | 'history') => void;
  /** réglages (IDE du projet) */
  settings: Settings;
}

function ProjectRow({
  project,
  favorite,
  open,
  sessions,
  expanded,
  unread,
  actions,
}: {
  project: ProjectView;
  favorite: boolean;
  /** sessions non lues qui ne sont pas visibles dessous (projet replié ou sessions non ouvertes) */
  unread: number;
  /** nombre de sessions ouvertes du projet */
  sessions: number;
  /** nombre de lignes enfants : sessions ouvertes et terminaux en cours */
  open: number;
  expanded: boolean;
  actions: ProjectActions;
}): JSX.Element {
  const empty = project.sessions.length === 0;
  // replié (ou sans session ouverte) : résumé d'activité sur la ligne du projet
  const summary = !expanded || sessions === 0;
  return (
    <Adw.ActionRow
      name={`p:${project.key}`}
      title={esc(project.name)}
      subtitle={esc(prettyPath(project.path))}
      subtitleLines={1}
      activatable
      cssClasses={[...(empty ? ['project-row', 'dim-label'] : ['project-row']), ...(expanded && open > 0 ? ['expanded'] : [])]}
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
            { label: 'Ouvrir le dossier', activate: () => openFolder(self, project.path, actions.toast) },
            ...ideMenuItem(project.path, actions),
          ],
          [{ label: 'Nouvelle tâche planifiée…', activate: () => openEditor(self, actions.tasks, undefined, project.path) }],
          [
            { label: 'MCP, skills et plugins…', activate: () => actions.extensions(self, project.path) },
            { label: 'Recharger la configuration', activate: () => actions.reloadConfig(self, project) },
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
      {unread > 0 ? (
        <Gtk.Label
          $type="suffix"
          label={String(unread)}
          valign={Gtk.Align.CENTER}
          cssClasses={['unread-badge']}
          tooltipText={plural(unread, 'réponse non lue', 'réponses non lues')}
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
function SessionTreeRow({ view, last, actions }: { view: SessionView; last: boolean; actions: ProjectActions }): JSX.Element {
  const s = view.session;
  const title = s.title === '' ? 'Sans titre' : s.title;
  const act = actions.sessionActions(s);
  return (
    <Gtk.ListBoxRow
      name={`s:${s.id}`}
      cssClasses={[...(last ? ['session-tree-row', 'last'] : ['session-tree-row']), ...(view.unread ? ['unread'] : [])]}
      tooltipText={view.unread ? `${title}\nRéponse non lue` : title}
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
      <Gtk.Box spacing={8} marginStart={34} marginEnd={4} cssClasses={['session-tree-inner']}>
        <Gtk.Box widthRequest={16} valign={Gtk.Align.CENTER}>
          {treeActivity(view)}
        </Gtk.Box>
        <Gtk.Label label={title} hexpand xalign={0} ellipsize={Pango.EllipsizeMode.END} cssClasses={['session-title']} />
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

/** « Ouvrir dans <IDE> » (IDE du projet), si un IDE est installé. */
function ideMenuItem(path: string, actions: ProjectActions): { label: string; activate: () => void }[] {
  const ide = ideFor(actions.settings, path, installedIdes());
  if (ide === null) return [];
  return [
    {
      label: `Ouvrir dans ${ide.name}`,
      activate: () => {
        try {
          openInIde(ide, path);
        } catch (e) {
          actions.toast(`Ouverture dans ${ide.name} impossible : ${errorMessage(e)}`);
        }
      },
    },
  ];
}

/** Lance / interrompt une action sur une tâche, erreur affichée. */
/**
 * Tâche planifiée, sous son projet : état du dernier run (spinner pendant un run), prochaine
 * exécution en infobulle, ▶ / ■ au survol, menu contextuel. Clic : session du dernier run.
 */
function TaskTreeRow({ view, last, actions }: { view: TaskView; last: boolean; actions: ProjectActions }): JSX.Element {
  const { task } = view;
  const ctx: TaskRowContext = { editor: actions.tasks, openSession: actions.openSession, openTasksWindow: actions.openTasksWindow };
  const state = taskState(view);
  const error = view.last?.error === undefined ? '' : `\n${view.last.error}`;
  return (
    <Gtk.ListBoxRow
      name={`k:${task.id}`}
      cssClasses={[...(last ? ['session-tree-row', 'last'] : ['session-tree-row']), ...(task.enabled ? [] : ['dim-label'])]}
      tooltipText={`${task.name} · ${describeSchedule(task.schedule)}\n${state.when === '' ? 'Lancée à la main uniquement' : state.when}\n${state.last}${error}`}
      $={(self: Gtk.ListBoxRow) => attachContextMenu(self, () => taskMenu(view, self, ctx))}
    >
      <Gtk.Box spacing={8} marginStart={34} marginEnd={4} cssClasses={['session-tree-inner']}>
        <Gtk.Box widthRequest={16} valign={Gtk.Align.CENTER}>
          {taskIcon(view)}
        </Gtk.Box>
        <Gtk.Label label={task.name} hexpand xalign={0} ellipsize={Pango.EllipsizeMode.END} cssClasses={['session-title']} />
        {taskRunButton(view, ctx, ['flat', 'circular', 'close-button'])}
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
      return view.unread ? (
        <Gtk.Box cssClasses={['unread-dot']} halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER} tooltipText="Réponse non lue" />
      ) : (
        <Gtk.Image iconName="chat-message-new-symbolic" cssClasses={['dim-label']} />
      );
    default:
      return <Gtk.Box />;
  }
}

/** Texte comparable : minuscules, sans accents. */
export const normalize = (s: string): string => s.normalize('NFD').replaceAll(/\p{Diacritic}/gu, '').toLowerCase();

/** Projet de la ligne (la ligne elle-même, ou la ligne de projet qui la précède). */
function projectRowOf(list: Gtk.ListBox, row: Gtk.ListBoxRow): Gtk.ListBoxRow | null {
  for (let i = row.get_index(); i >= 0; i -= 1) {
    const r = list.get_row_at_index(i);
    if (r?.name.startsWith('p:') === true) return r;
  }
  return null;
}

function rowNamed(list: Gtk.ListBox, name: string): Gtk.ListBoxRow | null {
  for (let i = 0, r = list.get_row_at_index(0); r !== null; i += 1, r = list.get_row_at_index(i)) if (r.name === name) return r;
  return null;
}

/** Ligne de projet suivante (après ses enfants), ou null. */
function nextProjectRow(list: Gtk.ListBox, row: Gtk.ListBoxRow): Gtk.ListBoxRow | null {
  for (let i = row.get_index() + 1, r = list.get_row_at_index(i); r !== null; i += 1, r = list.get_row_at_index(i)) {
    if (r.name.startsWith('p:')) return r;
  }
  return null;
}

/**
 * Glisser-déposer dans l'arbre : un projet favori (mode Favoris) réordonne les favoris, une
 * session ouverte se place parmi les sessions de son projet. Rien d'autre ne change l'ordre.
 */
function enableReorder(list: Gtk.ListBox, settings: Settings, projects: Accessor<readonly ProjectView[]>): void {
  const pathOf = (row: Gtk.ListBoxRow | null): string | null => {
    const key = row?.name.slice(2);
    return projects.peek().find((p) => p.key === key)?.path ?? null;
  };
  const source = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
  source.connect('prepare', (_s: Gtk.DragSource, _x: number, y: number) => {
    const row = list.get_row_at_y(Math.round(y));
    if (row === null) return null;
    const movable = row.name.startsWith('s:') || (row.name.startsWith('p:') && settings.data.peek().sidebarMode === 'favorites');
    if (!movable) return null;
    source.set_icon(Gtk.WidgetPaintable.new(row), 20, 10);
    return Gdk.ContentProvider.new_for_value(row.name);
  });
  list.add_controller(source);

  const target = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
  target.connect('drop', (_t: Gtk.DropTarget, value: unknown, _x: number, y: number) => {
    if (typeof value !== 'string') return false;
    const over = list.get_row_at_y(Math.round(y));
    if (over === null) return false;
    const [ok, origin] = over.compute_point(list, new Graphene.Point({ x: 0, y: 0 }));
    const upper = y - (ok ? origin.y : 0) < over.get_height() / 2;
    if (value.startsWith('p:')) {
      const moved = projects.peek().find((p) => `p:${p.key}` === value)?.path;
      const proj = projectRowOf(list, over);
      if (moved === undefined || proj === null) return false;
      // moitié haute d'une ligne de projet : avant lui ; sinon : avant le projet suivant
      const before = over === proj && upper ? proj : nextProjectRow(list, proj);
      settings.moveFavorite(moved, pathOf(before));
      return true;
    }
    if (value.startsWith('s:')) {
      const id = value.slice(2);
      const { openSessions } = settings.data.peek();
      // sessions du même projet uniquement
      const from = rowNamed(list, value);
      if (from === null || projectRowOf(list, from) !== projectRowOf(list, over)) return false;
      if (over.name.startsWith('s:')) {
        const onto = over.name.slice(2);
        // moitié basse : après la session survolée (avant la suivante, hors celle déplacée)
        const rest = openSessions.filter((x) => x !== id);
        settings.moveOpenSession(id, upper ? onto : (rest[rest.indexOf(onto) + 1] ?? null));
      } else if (over.name.startsWith('p:')) {
        // sur le projet : en tête de ses sessions
        const first = list.get_row_at_index(over.get_index() + 1);
        if (first?.name.startsWith('s:') !== true) return false;
        settings.moveOpenSession(id, first.name.slice(2));
      } else return false; // terminal, tâche : refusé
      return true;
    }
    return false;
  });
  list.add_controller(target);
}

/** Élément de l'arbre aplati : un projet, ou une de ses sessions ouvertes. */
type TreeItem =
  | { readonly kind: 'project'; readonly project: ProjectView; readonly favorite: boolean; readonly open: number; readonly sessions: number; readonly expanded: boolean; readonly unread: number }
  | { readonly kind: 'session'; readonly view: SessionView; readonly last: boolean }
  | { readonly kind: 'terminal'; readonly t: ProjectTerminal; readonly project: string; readonly last: boolean }
  | { readonly kind: 'task'; readonly view: TaskView; readonly last: boolean };

const treeKey = (i: TreeItem): string =>
  i.kind === 'project'
    ? `p|${i.project.key}|${i.project.working}|${i.project.waiting}|${i.unread}|${i.project.sessions.length === 0}|${i.project.name}|${i.favorite}|${i.open}|${i.sessions}|${i.expanded}`
    : i.kind === 'session'
      ? `s|${i.view.session.id}|${i.view.activity}|${i.view.unread}|${i.view.session.title}|${i.last}`
      : i.kind === 'terminal'
        ? `t|${i.project}|${i.t.id}|${i.t.name}|${i.t.command}|${i.last}`
        : `k|${i.view.task.id}|${i.view.task.name}|${i.view.task.enabled}|${i.view.running}|${i.view.last?.run ?? ''}|${i.view.last?.status ?? ''}|${i.view.next ?? ''}|${i.last}`;

function startServer(): void {
  // captures et tests : le serveur partagé de l'utilisateur n'est pas touché
  if (intercepted('SYSTEMCTL', `start ${SERVER_UNIT}`)) return;
  try {
    Gio.Subprocess.new(['systemctl', '--user', 'start', SERVER_UNIT], Gio.SubprocessFlags.NONE);
  } catch (e) {
    console.error(errorMessage(e));
  }
}

export function Sidebar({
  store,
  settings,
  projects: modeProjects,
  select,
  actions,
  shown,
  allProjects,
  terminals,
  unseenFailures,
  tasks,
}: {
  store: Store;
  settings: Settings;
  /** runs de tâches planifiées en échec, pas encore vus */
  unseenFailures: Accessor<number>;
  /** tâches planifiées (affichées sous leur projet) */
  tasks: Accessor<readonly TaskView[]>;
  projects: Accessor<readonly ProjectView[]>;
  select: (key: string) => void;
  actions: ProjectActions;
  /** ligne à mettre en évidence : `s:<session affichée>` ou `p:<projet>` */
  shown: Accessor<string>;
  /** tous les projets (la recherche ignore le mode Favoris / Tous) */
  allProjects: Accessor<readonly ProjectView[]>;
  /** terminaux persistants : ceux qui tournent apparaissent sous leur projet */
  terminals: TerminalContext;
}): JSX.Element {
  const conn = store.connection;
  const mode = settings.data((d) => d.sidebarMode);
  const favorites = settings.data((d) => d.favorites);
  // recherche : filtre tous les projets sur le nom et le chemin (sans casse ni accents)
  const [query, setQuery] = createState('');
  const projects = createComputed((): readonly ProjectView[] => {
    const q = normalize(query().trim());
    if (q === '') return modeProjects();
    return allProjects().filter((p) => normalize(`${p.name} ${p.path}`).includes(q));
  });
  const emptyFavorites = createComputed(() => query().trim() === '' && mode() === 'favorites' && projects().length === 0);
  const noMatch = createComputed(() => query().trim() !== '' && projects().length === 0);
  let searchBar: Gtk.SearchBar | null = null;
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
              const update = (): void => {
                menu.remove_all();
                const n = unseenFailures.peek();
                menu.append(n === 0 ? 'Tâches planifiées' : `Tâches planifiées (${n} échec${n > 1 ? 's' : ''})`, n === 0 ? 'app.tasks::tasks' : 'app.tasks::history');
                menu.append('MCP, skills et plugins (global)', 'app.extensions');
                menu.append('Serveur opencode', 'app.server');
                menu.append('Préférences', 'app.preferences');
                // pastille : un run planifié a échoué
                const icon = new Gtk.Overlay({ child: new Gtk.Image({ iconName: 'open-menu-symbolic' }) });
                if (n > 0) icon.add_overlay(new Gtk.Box({ halign: Gtk.Align.END, valign: Gtk.Align.START, cssClasses: ['failure-dot'] }));
                self.child = icon;
                self.tooltipText = n === 0 ? 'Menu principal' : `Menu principal — ${n} tâche${n > 1 ? 's' : ''} planifiée${n > 1 ? 's' : ''} en échec`;
              };
              update();
              onCleanup(unseenFailures.subscribe(update));
              self.menuModel = menu;
              labelMenuButton(self);
            }}
          />
          <Gtk.Button $type="end" iconName="view-refresh-symbolic" tooltipText="Recharger" onClicked={() => void store.reload()} />
          <Gtk.ToggleButton
            $type="end"
            iconName="system-search-symbolic"
            tooltipText="Rechercher un projet (Ctrl+K)"
            $={(self: Gtk.ToggleButton) => {
              // lié à la barre de recherche une fois celle-ci créée
              GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (searchBar !== null) searchBar.bind_property('search-mode-enabled', self, 'active', GObject.BindingFlags.BIDIRECTIONAL | GObject.BindingFlags.SYNC_CREATE);
                return GLib.SOURCE_REMOVE;
              });
            }}
          />
        </Adw.HeaderBar>
        <Gtk.SearchBar
          $type="top"
          $={(self: Gtk.SearchBar) => {
            searchBar = self;
            const entry = new Gtk.SearchEntry({ placeholderText: 'Rechercher un projet…', hexpand: true });
            self.child = entry;
            self.connect_entry(entry);
            entry.connect('search-changed', () => setQuery(entry.text));
            // Entrée : ouvre le premier résultat
            entry.connect('activate', () => {
              const first = projects.peek()[0];
              if (first === undefined) return;
              select(first.key);
              self.searchModeEnabled = false;
            });
            // fermeture (Échap, bouton) : liste complète rétablie
            self.connect('notify::search-mode-enabled', () => {
              if (self.searchModeEnabled) entry.grab_focus();
              else entry.text = '';
            });
            // Ctrl+K : ouvre la recherche depuis n'importe où dans la fenêtre
            const keys = new Gtk.ShortcutController({ scope: Gtk.ShortcutScope.GLOBAL });
            keys.add_shortcut(
              new Gtk.Shortcut({
                trigger: Gtk.ShortcutTrigger.parse_string('<Control>k'),
                action: Gtk.CallbackAction.new(() => {
                  self.searchModeEnabled = true;
                  entry.grab_focus();
                  return true;
                }),
              }),
            );
            self.add_controller(keys);
          }}
        />
        <Adw.Banner
          $type="top"
          revealed={conn((c) => c.state === 'error')}
          title={conn((c) => (c.state === 'error' ? esc(`Serveur opencode injoignable : ${c.message}`) : ''))}
          buttonLabel="Démarrer"
          onButtonClicked={startServer}
        />
        <Gtk.Stack visibleChildName={createComputed(() => (noMatch() ? 'nomatch' : emptyFavorites() ? 'empty' : 'list'))}>
          <Adw.StatusPage name="nomatch" $type="named" iconName="system-search-symbolic" title="Aucun projet" cssClasses={['compact']} />
          <Gtk.ScrolledWindow name="list" $type="named" vexpand hscrollbarPolicy={Gtk.PolicyType.NEVER}>
            <Gtk.ListBox
              cssClasses={['navigation-sidebar']}
              onRowActivated={(_self: Gtk.ListBox, row: Gtk.ListBoxRow) => {
                const name = row.name;
                if (name.startsWith('s:')) actions.openSession(name.slice(2));
                else if (name.startsWith('t:')) {
                  const [project = '', id] = name.slice(2).split('\n');
                  const t = terminals.settings.data.peek().terminals[project]?.find((x) => x.id === id);
                  if (t !== undefined) terminalActions(t, project, terminals).open();
                }
                else if (name.startsWith('p:')) select(name.slice(2));
                else if (name.startsWith('k:')) {
                  // tâche : session de son dernier run, sinon l'éditeur
                  const view = tasks.peek().find((v) => v.task.id === name.slice(2));
                  if (view?.last?.session !== undefined) actions.openSession(view.last.session);
                  else if (view !== undefined) openEditor(row, actions.tasks, view.task);
                }
              }}
              $={(self: Gtk.ListBox) => {
                // arbre aplati : chaque projet, puis s'il est déplié ses sessions ouvertes (ordre
                // d'ouverture, puis celui choisi par glisser-déposer), ses terminaux en cours et ses tâches
                terminals.manager.watch();
                const items = createComputed((): TreeItem[] => {
                  const { openSessions, collapsed, terminals: configured } = settings.data();
                  const running = terminals.manager.running();
                  const favs = favorites();
                  const allTasks = tasks();
                  const out: TreeItem[] = [];
                  for (const p of projects()) {
                    const byID = new Map(p.sessions.map((v) => [v.session.id, v]));
                    const open = openSessions.flatMap((id) => {
                      const v = byID.get(id);
                      return v === undefined ? [] : [v];
                    });
                    const terms = (configured[p.path] ?? []).filter((t) => running.has(t.id));
                    const own = allTasks.filter((t) => t.task.directory === p.path);
                    const children = open.length + terms.length + own.length;
                    const expanded = !collapsed.includes(p.key);
                    // non lues : celles qui n'apparaissent pas dessous (repliées ou non ouvertes)
                    const shownBelow = new Set(expanded ? open.map((v) => v.session.id) : []);
                    const unread = p.sessions.filter((v) => v.unread && !shownBelow.has(v.session.id)).length;
                    out.push({ kind: 'project', project: p, favorite: favs.includes(p.path), open: children, sessions: open.length, expanded, unread });
                    if (!expanded) continue;
                    // sessions ouvertes, terminaux en cours, puis tâches planifiées du projet
                    for (const [n, view] of open.entries()) out.push({ kind: 'session', view, last: n === children - 1 });
                    for (const [n, t] of terms.entries()) out.push({ kind: 'terminal', t, project: p.path, last: open.length + n === children - 1 });
                    for (const [n, view] of own.entries()) out.push({ kind: 'task', view, last: open.length + terms.length + n === children - 1 });
                  }
                  return out;
                });
                onCleanup(
                  keyedListBox(self, items, treeKey, (i) =>
                    i.kind === 'terminal'
                      ? TerminalTreeRow({ t: i.t, project: i.project, last: i.last, ctx: terminals })
                      : asWidget(
                          i.kind === 'project'
                            ? ProjectRow({ project: i.project, favorite: i.favorite, open: i.open, sessions: i.sessions, expanded: i.expanded, unread: i.unread, actions })
                            : i.kind === 'session'
                              ? SessionTreeRow({ view: i.view, last: i.last, actions })
                              : TaskTreeRow({ view: i.view, last: i.last, actions }),
                        ),
                  ),
                );
                enableReorder(self, settings, projects);
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


export function asWidget(o: JSX.Element): Gtk.Widget {
  if (!(o instanceof Gtk.Widget)) throw new TypeError('widget attendu');
  return o;
}
