// Fenêtre principale : projets (barre latérale) -> sessions du projet, synchronisés en direct.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createComputed, createMemo, createState, onCleanup, With, type Accessor } from 'gnim';
import { errorMessage, HttpError } from '../shared/errors.ts';
import { esc, fmtCost, fmtRelative, fmtStamp } from '../shared/format.ts';
import type { Session } from '../shared/schemas.ts';
import { prettyPath, type ProjectView, type SessionView, type Store } from '../shared/store.ts';
import { attachCommand, openTerminal, openTerminalArgv } from '../shared/terminal.ts';
import { createConversationPage, sessionTag, subagentTag, type ConversationPageHandle } from './ConversationPage.tsx';
import type { ProjectTerminal, Settings } from '../shared/settings.ts';
import { attachContextMenu } from './ContextMenu.ts';
import { openExtensions } from './ExtensionsDialog.ts';
import { openFolder } from './OpenFolder.ts';
import { IdeButton, ideFor, installedIdes, openInIde } from './Ide.ts';
import { openGitWindow } from './GitWindow.tsx';
import { reloadProjectConfig } from './ReloadConfig.ts';
import { keyedListBox } from './KeyedBox.ts';
import { confirmDelete, openEditor, STATUS, type EditorContext, type TasksMonitor, type TaskView } from './TasksWindow.tsx';
import { describeSchedule, isManual, removeTask, saveTask, startRun, stopRun } from '../shared/tasks.ts';
import { TerminalManager } from '../shared/terminals.ts';
import { TerminalBar, TerminalTreeRow, terminalActions, type TerminalContext } from './TerminalBar.tsx';
import { TerminalDock } from './TerminalPanel.tsx';
import { askDelete, askRename, attachSessionMenu, deleteButton, type SessionActions } from './SessionMenu.ts';

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
  actions,
}: {
  project: ProjectView;
  favorite: boolean;
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
      cssClasses={last ? ['session-tree-row', 'last'] : ['session-tree-row']}
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
function taskAct(actions: ProjectActions, what: string, fn: () => Promise<void>): void {
  fn()
    .then(() => actions.tasks.monitor.changed())
    .catch((e: unknown) => actions.toast(`${what} : ${errorMessage(e)}`));
}

/**
 * Tâche planifiée, sous son projet : état du dernier run (spinner pendant un run), prochaine
 * exécution en infobulle, ▶ / ■ au survol, menu contextuel. Clic : session du dernier run.
 */
function TaskTreeRow({ view, last, actions }: { view: TaskView; last: boolean; actions: ProjectActions }): JSX.Element {
  const { task, running } = view;
  const status = view.last === null ? null : STATUS[view.last.status];
  const when = running ? 'Run en cours' : isManual(task) ? 'Lancée à la main uniquement' : task.enabled ? (view.next === null ? 'Pas de prochaine exécution' : `Prochaine exécution : ${fmtStamp(view.next)}`) : 'Désactivée';
  const lastText = view.last === null ? 'Jamais lancée' : `Dernier run : ${STATUS[view.last.status].label.toLowerCase()} ${fmtRelative(view.last.start)}${view.last.error === undefined ? '' : `\n${view.last.error}`}`;
  const run = (): void => taskAct(actions, running ? 'Arrêt impossible' : 'Lancement impossible', () => (running ? stopRun(task) : startRun(task)));
  return (
    <Gtk.ListBoxRow
      name={`k:${task.id}`}
      cssClasses={[...(last ? ['session-tree-row', 'last'] : ['session-tree-row']), ...(task.enabled ? [] : ['dim-label'])]}
      tooltipText={`${task.name} · ${describeSchedule(task.schedule)}\n${when}\n${lastText}`}
      $={(self: Gtk.ListBoxRow) => {
        attachContextMenu(self, () => [
          [
            { label: running ? 'Interrompre le run' : 'Lancer maintenant', activate: run },
            ...(view.last?.session === undefined ? [] : [{ label: 'Ouvrir la dernière session', activate: () => actions.openSession(view.last?.session ?? '') }]),
            { label: 'Historique…', activate: () => actions.openTasksWindow('history') },
          ],
          [
            { label: 'Modifier…', activate: () => openEditor(self, actions.tasks, task) },
            { label: task.enabled ? 'Désactiver' : 'Activer', activate: () => taskAct(actions, 'Modification impossible', () => saveTask({ ...task, enabled: !task.enabled })) },
          ],
          [{ label: 'Supprimer…', activate: () => confirmDelete(self, task, () => taskAct(actions, 'Suppression impossible', () => removeTask(task.id))) }],
        ]);
      }}
    >
      <Gtk.Box spacing={8} marginStart={34} marginEnd={4} cssClasses={['session-tree-inner']}>
        <Gtk.Box widthRequest={16} valign={Gtk.Align.CENTER}>
          {running ? (
            <Adw.Spinner tooltipText="Run en cours" />
          ) : (
            <Gtk.Image iconName="alarm-symbolic" cssClasses={status === null || view.last?.status === 'success' ? ['dim-label'] : [status.css]} tooltipText={status?.label ?? 'Jamais lancée'} />
          )}
        </Gtk.Box>
        <Gtk.Label label={task.name} hexpand xalign={0} ellipsize={Pango.EllipsizeMode.END} cssClasses={['session-title']} />
        <Gtk.Button
          iconName={running ? 'media-playback-stop-symbolic' : 'media-playback-start-symbolic'}
          tooltipText={running ? 'Interrompre le run' : 'Lancer maintenant'}
          valign={Gtk.Align.CENTER}
          cssClasses={['flat', 'circular', 'close-button']}
          onClicked={run}
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

/** Texte comparable : minuscules, sans accents. */
const normalize = (s: string): string => s.normalize('NFD').replaceAll(/\p{Diacritic}/gu, '').toLowerCase();

/** Élément de l'arbre aplati : un projet, ou une de ses sessions ouvertes. */
type TreeItem =
  | { readonly kind: 'project'; readonly project: ProjectView; readonly favorite: boolean; readonly open: number; readonly sessions: number; readonly expanded: boolean }
  | { readonly kind: 'session'; readonly view: SessionView; readonly last: boolean }
  | { readonly kind: 'terminal'; readonly t: ProjectTerminal; readonly project: string; readonly last: boolean }
  | { readonly kind: 'task'; readonly view: TaskView; readonly last: boolean };

const treeKey = (i: TreeItem): string =>
  i.kind === 'project'
    ? `p|${i.project.key}|${i.project.working}|${i.project.waiting}|${i.project.sessions.length === 0}|${i.project.name}|${i.favorite}|${i.open}|${i.sessions}|${i.expanded}`
    : i.kind === 'session'
      ? `s|${i.view.session.id}|${i.view.activity}|${i.view.session.title}|${i.last}`
      : i.kind === 'terminal'
        ? `t|${i.project}|${i.t.id}|${i.t.name}|${i.t.command}|${i.last}`
        : `k|${i.view.task.id}|${i.view.task.name}|${i.view.task.enabled}|${i.view.running}|${i.view.last?.run ?? ''}|${i.view.last?.status ?? ''}|${i.view.next ?? ''}|${i.last}`;

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
          title={conn((c) => (c.state === 'error' ? `Serveur opencode injoignable : ${c.message}` : ''))}
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
                // d'ouverture) et ses terminaux en cours
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
                    out.push({ kind: 'project', project: p, favorite: favs.includes(p.path), open: children, sessions: open.length, expanded });
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
                            ? ProjectRow({ project: i.project, favorite: i.favorite, open: i.open, sessions: i.sessions, expanded: i.expanded, actions })
                            : i.kind === 'session'
                              ? SessionTreeRow({ view: i.view, last: i.last, actions })
                              : TaskTreeRow({ view: i.view, last: i.last, actions }),
                        ),
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
        {deleteButton(act.delete)}
      </Gtk.Box>
    </Adw.ActionRow>
  );
}

/** Contexte des tâches planifiées pour la page d'un projet. */
interface ProjectTasksContext {
  readonly tasks: Accessor<readonly TaskView[]>;
  readonly editor: EditorContext;
  readonly openSession: (sessionID: string) => void;
  readonly openTasksWindow: (page: 'tasks' | 'history') => void;
  readonly toast: (message: string) => void;
}

function runTaskAction(ctx: ProjectTasksContext, what: string, fn: () => Promise<void>, failed?: () => void): void {
  fn()
    .then(() => ctx.editor.monitor.changed())
    .catch((e: unknown) => {
      ctx.toast(`${what} : ${errorMessage(e)}`);
      failed?.();
    });
}

/** Ligne d'une tâche sur la page du projet : état, horaire, prochaine exécution, actions. */
function ProjectTaskRow({ view, ctx }: { view: TaskView; ctx: ProjectTasksContext }): Gtk.Widget {
  const { task, running } = view;
  const status = view.last === null ? null : STATUS[view.last.status];
  const when = running ? 'run en cours…' : isManual(task) ? '' : task.enabled ? (view.next === null ? 'pas de prochaine exécution' : `prochaine : ${fmtStamp(view.next)}`) : 'désactivée';
  const lastText = view.last === null ? 'jamais lancée' : `dernier run : ${STATUS[view.last.status].label.toLowerCase()} ${fmtRelative(view.last.start)}`;
  const row = new Adw.ActionRow({
    title: esc(task.name),
    subtitle: esc(`${[describeSchedule(task.schedule), when, lastText].filter((x) => x !== '').join(' · ')}${view.last?.error === undefined ? '' : `\n${view.last.error}`}`),
    subtitleLines: 2,
    activatable: true,
    tooltipText: task.prompt.slice(0, 400),
  });
  if (!task.enabled) row.add_css_class('dim-label');
  row.add_prefix(
    running
      ? new Adw.Spinner({ tooltipText: 'Run en cours' })
      : new Gtk.Image({ iconName: 'alarm-symbolic', cssClasses: status === null || view.last?.status === 'success' ? ['dim-label'] : [status.css], tooltipText: status?.label ?? 'Jamais lancée' }),
  );
  const runBtn = new Gtk.Button({ iconName: running ? 'media-playback-stop-symbolic' : 'media-playback-start-symbolic', tooltipText: running ? 'Interrompre le run' : 'Lancer maintenant', valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
  runBtn.connect('clicked', () => runTaskAction(ctx, running ? 'Arrêt impossible' : 'Lancement impossible', () => (running ? stopRun(task) : startRun(task))));
  const sw = new Gtk.Switch({ active: task.enabled, valign: Gtk.Align.CENTER, tooltipText: task.enabled ? 'Désactiver' : 'Activer' });
  sw.connect('notify::active', () => {
    // échec : l'interrupteur revient à l'état réel de la tâche (#81)
    if (sw.active !== task.enabled) runTaskAction(ctx, 'Modification impossible', () => saveTask({ ...task, enabled: sw.active }), () => {
        sw.active = task.enabled;
      });
  });
  const more = new Gtk.Button({ iconName: 'view-more-symbolic', tooltipText: 'Plus d’actions', valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
  const menu = (): readonly (readonly { label: string; activate: () => void }[])[] => [
    [
      ...(view.last?.session === undefined ? [] : [{ label: 'Ouvrir la dernière session', activate: () => ctx.openSession(view.last?.session ?? '') }]),
      { label: 'Historique…', activate: () => ctx.openTasksWindow('history') },
      { label: 'Modifier…', activate: () => openEditor(row, ctx.editor, task) },
    ],
    [{ label: 'Supprimer…', activate: () => confirmDelete(row, task, () => runTaskAction(ctx, 'Suppression impossible', () => removeTask(task.id))) }],
  ];
  attachContextMenu(row, menu);
  attachContextMenu(more, menu, { primary: true });
  row.add_suffix(runBtn);
  row.add_suffix(sw);
  row.add_suffix(more);
  // clic : session du dernier run, sinon l'éditeur
  row.connect('activated', () => {
    if (view.last?.session === undefined) openEditor(row, ctx.editor, task);
    else ctx.openSession(view.last.session);
  });
  return row;
}

/** Section « Tâches planifiées » de la page d'un projet, avec création directe. */
function ProjectTasks({ project, ctx }: { project: Accessor<string | null>; ctx: ProjectTasksContext }): JSX.Element {
  const own = createComputed(() => {
    const path = project();
    return ctx.tasks().filter((v) => v.task.directory === path);
  });
  const create = (self: Gtk.Widget): void => {
    const path = project.peek();
    if (path !== null) openEditor(self, ctx.editor, undefined, path);
  };
  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={6} marginBottom={18}>
      <Gtk.Box spacing={6}>
        <Gtk.Label label="Tâches planifiées" xalign={0} hexpand cssClasses={['heading']} />
        <Gtk.Button iconName="list-add-symbolic" tooltipText="Nouvelle tâche planifiée" cssClasses={['flat']} onClicked={(self: Gtk.Button) => create(self)} />
      </Gtk.Box>
      <Gtk.ListBox
        cssClasses={['boxed-list']}
        selectionMode={Gtk.SelectionMode.NONE}
        visible={own((l) => l.length > 0)}
        $={(self: Gtk.ListBox) => {
          onCleanup(keyedListBox(self, own, (v) => JSON.stringify([v.task, v.running, v.next, v.last?.run, v.last?.status]), (v) => ProjectTaskRow({ view: v, ctx })));
        }}
      />
      <Gtk.Label
        label="Aucune tâche : planifie un prompt (revue quotidienne, veille, rapport…) avec le bouton +."
        xalign={0}
        wrap
        visible={own((l) => l.length === 0)}
        cssClasses={['dim-label', 'caption']}
      />
      <Gtk.Label label="Sessions" xalign={0} marginTop={12} cssClasses={['heading']} />
    </Gtk.Box>
  );
}

function SessionList({ sessions, actions, header }: { sessions: Accessor<readonly SessionView[]>; actions: Actions; header?: JSX.Element }): JSX.Element {
  // Ordre exact du store (date de mise à jour décroissante). La clé inclut ce qui est affiché :
  // une session modifiée est reconstruite et replacée à sa nouvelle position.
  return (
    <Gtk.ScrolledWindow vexpand hscrollbarPolicy={Gtk.PolicyType.NEVER}>
      <Adw.Clamp maximumSize={900} marginTop={12} marginBottom={12} marginStart={12} marginEnd={12}>
        <Gtk.Box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.START}>
        {header ?? null}
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
        </Gtk.Box>
      </Adw.Clamp>
    </Gtk.ScrolledWindow>
  );
}

function asWidget(o: JSX.Element): Gtk.Widget {
  if (!(o instanceof Gtk.Widget)) throw new TypeError('widget attendu');
  return o;
}

function SessionsPage({
  store,
  current,
  actions,
  terminals,
  tasks,
}: {
  store: Store;
  current: Accessor<ProjectView | null>;
  actions: Actions;
  terminals: TerminalContext;
  tasks: ProjectTasksContext;
}): JSX.Element {
  const projectPath = current((p) => p?.path ?? null);
  const key = createMemo(() => current()?.key ?? null);
  // recherche dans les sessions du projet (titre, agent, modèle), sans casse ni accents
  const [query, setQuery] = createState('');
  const allSessions = createComputed(() => current()?.sessions ?? []);
  const sessions = createComputed((): readonly SessionView[] => {
    const q = normalize(query().trim());
    if (q === '') return allSessions();
    return allSessions().filter((v) => normalize(`${v.session.title} ${v.session.agent ?? ''} ${v.session.model?.id ?? ''}`).includes(q));
  });
  const empty = createMemo(() => allSessions().length === 0);
  const noMatch = createMemo(() => !empty() && sessions().length === 0);
  let searchBar: Gtk.SearchBar | null = null;
  const newSession = (): void => {
    const p = current();
    if (p !== null) actions.newSession(p.path);
  };
  return (
    <Adw.NavigationPage
      title={current((p) => p?.name ?? 'opencode')}
      tag="sessions"
      $={(self: Adw.NavigationPage) => {
        // Ctrl+F : recherche dans la liste des sessions affichée
        const keys = new Gtk.ShortcutController({ scope: Gtk.ShortcutScope.MANAGED });
        keys.add_shortcut(
          new Gtk.Shortcut({
            trigger: Gtk.ShortcutTrigger.parse_string('<Control>f'),
            action: Gtk.CallbackAction.new(() => {
              if (searchBar !== null) searchBar.searchModeEnabled = true;
              return true;
            }),
          }),
        );
        self.add_controller(keys);
        // changement de projet : recherche réinitialisée
        onCleanup(
          key.subscribe(() => {
            if (searchBar !== null) searchBar.searchModeEnabled = false;
          }),
        );
      }}
    >
      <Adw.ToolbarView>
        <Adw.HeaderBar $type="top">
          <Adw.WindowTitle $type="title" title={current((p) => p?.name ?? 'opencode')} subtitle={current((p) => (p === null ? '' : prettyPath(p.path)))} />
          <Gtk.Button $type="end" iconName="tab-new-symbolic" tooltipText="Nouvelle session" sensitive={key((k) => k !== null)} onClicked={newSession} />
          <Gtk.Box $type="end">{terminals.dock.toggleButton()}</Gtk.Box>
          <Gtk.ToggleButton
            $type="end"
            iconName="system-search-symbolic"
            tooltipText="Rechercher une session (Ctrl+F)"
            $={(self: Gtk.ToggleButton) => {
              GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (searchBar !== null) searchBar.bind_property('search-mode-enabled', self, 'active', GObject.BindingFlags.BIDIRECTIONAL | GObject.BindingFlags.SYNC_CREATE);
                return GLib.SOURCE_REMOVE;
              });
            }}
          />
          <Gtk.Button
            $type="end"
            iconName="document-revert-symbolic"
            tooltipText="Recharger la configuration du projet (opencode.json, agents, commandes, skills, MCP)"
            sensitive={key((k) => k !== null)}
            onClicked={(self: Gtk.Button) => {
              const p = current.peek();
              if (p !== null) reloadProjectConfig(self, store.client, p.path, p.working, actions.toast);
            }}
          />
          <Gtk.Button
            $type="end"
            iconName="application-x-addon-symbolic"
            tooltipText="MCP, skills et plugins du projet"
            sensitive={key((k) => k !== null)}
            onClicked={(self: Gtk.Button) => {
              const p = current.peek();
              if (p !== null) openExtensions(self, store.client, p.path);
            }}
          />
          <Gtk.Button
            $type="end"
            iconName="folder-open-symbolic"
            tooltipText="Ouvrir le dossier"
            sensitive={key((k) => k !== null)}
            onClicked={(self: Gtk.Button) => {
              const p = current.peek();
              if (p !== null) openFolder(self, p.path, actions.toast);
            }}
          />
          <Gtk.Box $type="end">{IdeButton({ project: current((p) => p?.path ?? null), settings: terminals.settings, toast: actions.toast })}</Gtk.Box>
          <Gtk.Button
            $type="end"
            iconName="og-git-symbolic"
            tooltipText="Git : modifications, journal, branches, comparaison"
            visible={current((p) => p?.vcs === true)}
            onClicked={(self: Gtk.Button) => {
              const p = current.peek();
              if (p === null) return;
              openGitWindow(self, { directory: p.path, title: p.name, load: () => store.client.gitDiff(p.path) });
            }}
          />
        </Adw.HeaderBar>
        <Gtk.SearchBar
          $type="top"
          $={(self: Gtk.SearchBar) => {
            searchBar = self;
            const entry = new Gtk.SearchEntry({ placeholderText: 'Rechercher une session…', hexpand: true });
            self.child = new Adw.Clamp({ maximumSize: 900, child: entry });
            self.connect_entry(entry);
            entry.connect('search-changed', () => setQuery(entry.text));
            // Entrée : ouvre la première session trouvée
            entry.connect('activate', () => {
              const first = sessions.peek()[0];
              if (first === undefined) return;
              self.searchModeEnabled = false;
              actions.openSession(first.session.id);
            });
            self.connect('notify::search-mode-enabled', () => {
              if (self.searchModeEnabled) entry.grab_focus();
              else entry.text = '';
            });
          }}
        />
        <Gtk.Box $type="top">
          <TerminalBar project={current((p) => p?.path ?? null)} ctx={terminals} />
        </Gtk.Box>
        <With value={createMemo(() => `${key() ?? ''}|${String(empty())}|${String(noMatch())}|${store.connection().state}`)}>
          {() => {
            if (store.connection.peek().state !== 'connected' && store.projects.peek().length === 0) {
              return <Adw.StatusPage iconName="network-offline-symbolic" title="Connexion au serveur opencode…" description={esc(store.client.url)} vexpand />;
            }
            if (key.peek() === null) return <Adw.StatusPage iconName="folder-symbolic" title="Aucun projet" description="Lance opencode dans un répertoire pour commencer." vexpand />;
            if (empty.peek()) {
              return (
                <Gtk.Box orientation={Gtk.Orientation.VERTICAL} vexpand>
                  <Adw.Clamp maximumSize={900} marginTop={12} marginStart={12} marginEnd={12}>
                    <ProjectTasks project={projectPath} ctx={tasks} />
                  </Adw.Clamp>
                  <Adw.StatusPage iconName="chat-bubbles-empty-symbolic" title="Aucune session" vexpand cssClasses={['compact']}>
                    <Gtk.Button label="Nouvelle session" halign={Gtk.Align.CENTER} cssClasses={['pill', 'suggested-action']} onClicked={newSession} />
                  </Adw.StatusPage>
                </Gtk.Box>
              );
            }
            if (noMatch.peek()) return <Adw.StatusPage iconName="system-search-symbolic" title="Aucune session" description="Aucune session ne correspond à la recherche." vexpand />;
            // pas de tâches pendant une recherche de sessions
            return (
              <SessionList
                sessions={sessions}
                actions={actions}
                header={
                  <Gtk.Box orientation={Gtk.Orientation.VERTICAL} visible={query((q) => q.trim() === '')}>
                    <ProjectTasks project={projectPath} ctx={tasks} />
                  </Gtk.Box>
                }
              />
            );
          }}
        </With>
      </Adw.ToolbarView>
    </Adw.NavigationPage>
  );
}

// ---------------------------------------------------------------- fenêtre

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 700;

/**
 * Adw.NavigationSplitView n'est pas redimensionnable : poignée sur le bord droit de la barre
 * latérale (curseur de redimensionnement) ; la largeur glissée est fixée (min = max) et mémorisée.
 * Double-clic : retour à la largeur automatique.
 */
function makeSidebarResizable(split: Adw.NavigationSplitView, settings: Settings): void {
  const apply = (w: number): void => {
    if (w <= 0) {
      split.minSidebarWidth = 240;
      split.maxSidebarWidth = 340;
    } else {
      split.maxSidebarWidth = Math.max(w, split.minSidebarWidth);
      split.minSidebarWidth = w;
      split.maxSidebarWidth = w;
    }
  };
  apply(settings.data.peek().sidebarWidth);

  // poignée (curseur et survol) en surimpression du contenu, contre la barre latérale
  const handle = new Gtk.Box({ widthRequest: 6, halign: Gtk.Align.START, valign: Gtk.Align.FILL, cssClasses: ['sidebar-handle'] });
  handle.set_cursor_from_name('col-resize');
  const page = split.content;
  if (page !== null) {
    const child = page.child;
    page.child = null;
    page.child = new Gtk.Overlay({ child });
    if (page.child instanceof Gtk.Overlay) page.child.add_overlay(handle);
  }

  // le glissement est suivi sur le split (immobile) : les coordonnées ne bougent pas avec la poignée
  const edge = (): number => split.sidebar?.get_width() ?? 0;
  let dragging = false;
  let start = 0;
  let lastPress = 0;
  const drag = new Gtk.GestureDrag({ propagationPhase: Gtk.PropagationPhase.CAPTURE });
  drag.connect('drag-begin', (g: Gtk.GestureDrag, x: number) => {
    // uniquement sur la bordure (6 px après la barre latérale), barre latérale visible à côté
    dragging = !split.collapsed && x >= edge() - 2 && x <= edge() + 8;
    if (!dragging) {
      g.set_state(Gtk.EventSequenceState.DENIED);
      return;
    }
    g.set_state(Gtk.EventSequenceState.CLAIMED);
    start = edge();
    // double-clic sur la bordure : largeur automatique
    const now = GLib.get_monotonic_time();
    if (now - lastPress < 400_000) {
      dragging = false;
      settings.setNumber('sidebarWidth', 0);
      apply(0);
    }
    lastPress = now;
  });
  drag.connect('drag-update', (_g: Gtk.GestureDrag, dx: number) => {
    if (dragging) apply(Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, start + dx))));
  });
  drag.connect('drag-end', () => {
    if (!dragging) return;
    dragging = false;
    settings.setNumber('sidebarWidth', split.minSidebarWidth);
  });
  split.add_controller(drag);
}

function asPage(o: JSX.Element): Adw.NavigationPage {
  if (!(o instanceof Adw.NavigationPage)) throw new TypeError('NavigationPage attendue');
  return o;
}

export interface WindowApi {
  openSession: (sessionID: string) => void;
  /** ferme la session affichée (Ctrl+W) */
  closeCurrent: () => void;
  /** session affichée, ou null */
  shownSession: () => string | null;
  /** dossier du projet affiché, ou null */
  currentDirectory: () => string | null;
}

/** Fenêtres dont la fermeture a été confirmée : leur prochaine `close-request` passe. */
const closeConfirmed = new WeakSet<Gtk.Window>();

/**
 * Fermeture de la fenêtre : si des terminaux persistants tournent, propose de les arrêter
 * (Annuler / Laisser tourner / Tout arrêter) ; les terminaux intégrés ouverts (arrêtés avec la
 * fenêtre) sont signalés aussi. Renvoie true pour suspendre la fermeture.
 */
function confirmClose(win: Adw.ApplicationWindow, settings: Settings, manager: TerminalManager, dock: TerminalDock): boolean {
  if (closeConfirmed.has(win)) return false;
  const running = Object.entries(settings.data.peek().terminals).flatMap(([project, list]) =>
    list.filter((t) => manager.isRunning(t.id)).map((t) => ({ t, label: `${t.name} — ${GLib.path_get_basename(project)}` })),
  );
  const integrated = dock.livingTabs().map((t) => `${t.title} — ${GLib.path_get_basename(t.project)}`);
  if (running.length === 0 && integrated.length === 0) return false;
  const n = running.length;
  const parts = [
    n === 0 ? '' : `${running.map((r) => `• ${r.label}`).join('\n')}\n\nLes laisser tourner en arrière-plan ou les arrêter ?`,
    integrated.length === 0 ? '' : `${n === 0 ? 'Ils seront arrêtés' : 'Terminaux intégrés, arrêtés'} avec la fenêtre :\n${integrated.map((l) => `• ${l}`).join('\n')}`,
  ].filter((x) => x !== '');
  const dialog = new Adw.AlertDialog({
    heading: n === 0 ? 'Des terminaux intégrés sont ouverts' : n === 1 ? 'Un terminal tourne encore' : `${n} terminaux tournent encore`,
    body: parts.join('\n\n'),
    defaultResponse: 'keep',
    closeResponse: 'cancel',
  });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('keep', n === 0 ? 'Fermer' : 'Laisser tourner');
  if (n > 0) {
    dialog.add_response('stop', n === 1 ? 'Arrêter' : 'Tout arrêter');
    dialog.set_response_appearance('stop', Adw.ResponseAppearance.DESTRUCTIVE);
  }
  const close = (): void => {
    closeConfirmed.add(win);
    win.close();
  };
  dialog.connect('response', (_d: Adw.AlertDialog, response: string) => {
    if (response === 'cancel') return;
    if (response === 'keep') {
      close();
      return;
    }
    void Promise.allSettled(running.map((r) => manager.stop(r.t))).then(close);
  });
  dialog.present(win);
  return true;
}

export function MainWindow({
  app,
  store,
  settings,
  size,
  ready,
  tasks,
}: {
  app: Adw.Application;
  store: Store;
  settings: Settings;
  size?: [number, number];
  ready: (api: WindowApi) => void;
  /** tâches planifiées : échecs non vus (pastille du menu principal) */
  tasks: TasksMonitor;
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

  /** pages des sous-agents, empilées au-dessus de la session parente, libérées une fois retirées */
  const subPages = new Map<string, ConversationPageHandle>();
  const pageOptions = () => ({
    store,
    settings,
    attach: actions.attach,
    toast: actions.toast,
    newSession: actions.newSession,
    sessionActions: actions.sessionActions,
    terminals,
    openSubagent,
    forkFrom,
  });
  /** texte à pré-remplir dans la page de la prochaine session ouverte (fork depuis un message) */
  const drafts = new Map<string, { text: string; from: Session | undefined }>();
  const forkFrom = (sessionID: string, directory: string, messageID: string, text: string): void => {
    store.client
      .forkSession(sessionID, directory, messageID)
      .then((copy) => {
        store.upsertSession(copy);
        // la copie n'a ni agent ni modèle : ceux de la session d'origine sont présélectionnés
        drafts.set(copy.id, { text, from: store.session(sessionID) });
        actions.openSession(copy.id);
        actions.toast('Session forkée : modifie le message puis envoie-le');
        return copy;
      })
      .catch((e: unknown) => actions.toast(`Fork impossible : ${errorMessage(e)}`));
  };
  const openSubagent = (sessionID: string): void => {
    let handle = subPages.get(sessionID);
    if (handle === undefined) {
      handle = createConversationPage({ ...pageOptions(), sessionID, child: true });
      subPages.set(sessionID, handle);
    }
    if (nav.visiblePage === handle.page) return;
    if (nav.find_page(subagentTag(sessionID)) === null) nav.push(handle.page);
    else nav.pop_to_page(handle.page);
  };
  nav.connect('notify::visible-page', () => {
    for (const [id, handle] of subPages) {
      if (nav.find_page(subagentTag(id)) !== null) continue;
      subPages.delete(id);
      handle.dispose();
    }
  });

  const toast = (title: string): void => {
    overlay?.add_toast(new Adw.Toast({ title: esc(title), timeout: 4 }));
  };
  /** Exécute une action serveur ; en cas d'échec, affiche l'erreur. */
  /** Exécute une action serveur ; en cas d'échec, affiche l'erreur. Résolue à false si échec. */
  const run = (what: string, fn: () => Promise<void>): Promise<boolean> =>
    fn().then(
      () => true,
      (e: unknown) => {
        toast(`${what} : ${errorMessage(e)}`);
        return false;
      },
    );

  const externalAttach = (directory: string, sessionID?: string): void => {
    try {
      const { terminal, terminalCommand } = settings.data.peek();
      openTerminal(attachCommand(store.client.url, directory, sessionID), GLib.file_test(directory, GLib.FileTest.IS_DIR) ? directory : GLib.get_home_dir(), {
        terminal,
        command: terminalCommand,
      });
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  const shell = GLib.getenv('SHELL') ?? '/bin/sh';
  const dock = new TerminalDock({
    content: nav,
    settings,
    newShell: (project, n) => ({
      key: `shell:${GLib.get_monotonic_time()}`,
      title: n === 1 ? 'Shell' : `Shell ${n}`,
      tooltip: `${GLib.path_get_basename(shell)} dans ${prettyPath(project)}`,
      icon: 'utilities-terminal-symbolic',
      argv: [shell],
      cwd: project,
      external: () => {
        try {
          const { terminal, terminalCommand } = settings.data.peek();
          openTerminalArgv([shell], project, { terminal, command: terminalCommand });
        } catch (e) {
          toast(errorMessage(e));
        }
      },
    }),
  });
  dock.setProject(current.peek()?.path ?? null);
  onCleanup(current.subscribe(() => dock.setProject(current.peek()?.path ?? null)));

  const terminals: TerminalContext = {
    dock,
    settings,
    manager: new TerminalManager(() => {
      const { terminal, terminalCommand } = settings.data.peek();
      return { terminal, command: terminalCommand };
    }),
    toast,
  };

  const actions: Actions = {
    toast,
    attach: (directory, sessionID) => {
      if (!dock.enabled()) {
        externalAttach(directory, sessionID);
        return;
      }
      // onglet dans le panneau du projet de la session (sinon du dossier, sinon du projet affiché)
      const projects = store.projects.peek();
      const project =
        (sessionID === undefined ? undefined : projects.find((p) => p.sessions.some((v) => v.session.id === sessionID))?.path) ??
        projects.find((p) => p.path === directory)?.path ??
        current.peek()?.path ??
        directory;
      const title = sessionID === undefined ? '' : (store.session(sessionID)?.title ?? '');
      dock.open(project, {
        key: sessionID === undefined ? `opencode:${GLib.get_monotonic_time()}` : `attach:${sessionID}`,
        title: title === '' ? 'opencode' : title,
        tooltip: `opencode attach${sessionID === undefined ? '' : ` --session ${sessionID}`}\n${prettyPath(directory)}`,
        icon: 'utilities-terminal-symbolic',
        argv: ['opencode', 'attach', store.client.url, '--dir', directory, ...(sessionID === undefined ? [] : ['--session', sessionID])],
        cwd: directory,
        external: () => externalAttach(directory, sessionID),
      });
    },
    sessionActions: (session) => ({
      open: () => actions.openSession(session.id),
      openInTerminal: () => actions.attach(session.directory, session.id),
      rename: (title) =>
        void run('Renommage impossible', async () => {
          store.upsertSession(await store.client.renameSession(session.id, session.directory, title));
        }),
      fork: () =>
        void run('Fork impossible', async () => {
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
        const draft = drafts.get(sessionID);
        drafts.delete(sessionID);
        handle = createConversationPage({ ...pageOptions(), sessionID, ...(draft === undefined ? {} : { draft: draft.text, ...(draft.from === undefined ? {} : { draftFrom: draft.from }) }) });
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
    if (tag.startsWith('subagent:')) return;
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

  const projectTasks: ProjectTasksContext = {
    tasks: tasks.tasks,
    editor: { store, monitor: tasks, toast },
    openSession: (id) => actions.openSession(id),
    openTasksWindow: (page) => app.activate_action('tasks', new GLib.Variant('s', page)),
    toast,
  };
  nav.add(asPage(SessionsPage({ store, current, actions, terminals, tasks: projectTasks })));
  const shownSession = (): string | null => {
    const tag = nav.visiblePage?.tag ?? '';
    return tag.startsWith('session:') ? tag.slice('session:'.length) : null;
  };
  ready({
    openSession: actions.openSession,
    currentDirectory: () => current.peek()?.path ?? null,
    closeCurrent: () => {
      const id = shownSession();
      if (id !== null) actions.closeSession(id);
      // Ctrl+W sur un sous-agent : retour à la session parente
      else if ((nav.visiblePage?.tag ?? '').startsWith('subagent:')) nav.pop();
    },
    shownSession,
  });

  /** Ligne mise en évidence dans la barre latérale : session affichée, sinon projet courant. */
  const [shown, setShown] = createState('');
  const updateShown = (): void => {
    const tag = nav.visiblePage?.tag ?? '';
    // sous-agent : la session parente reste mise en évidence
    if (tag.startsWith('subagent:')) return;
    setShown(tag.startsWith('session:') ? `s:${tag.slice('session:'.length)}` : `p:${current.peek()?.key ?? ''}`);
  };
  nav.connect('notify::visible-page', updateShown);
  onCleanup(current.subscribe(updateShown));

  // fenêtre fermée : pages des sessions (abonnements au store), relecture des terminaux
  // persistants et terminaux intégrés libérés (#77)
  onCleanup(() => {
    for (const handle of [...pages.values(), ...subPages.values()]) handle.dispose();
    pages.clear();
    subPages.clear();
    terminals.manager.dispose();
    dock.dispose();
  });

  // Sessions ouvertes absentes de la liste chargée : soit supprimées ailleurs, soit simplement
  // plus anciennes que les sessions chargées (limite du serveur). Vérifiées une à une : fermées
  // seulement si le serveur répond 404, sinon ajoutées au store (#59).
  const checking = new Set<string>();
  /** sessions confirmées par le serveur : pas revérifiées avant une minute */
  const alive = new Map<string, number>();
  onCleanup(
    store.projects.subscribe(() => {
      if (store.connection.peek().state !== 'connected') return;
      const known = new Set(store.projects.peek().flatMap((p) => p.sessions.map((v) => v.session.id)));
      for (const id of settings.data.peek().openSessions) {
        if (known.has(id) || checking.has(id) || Date.now() - (alive.get(id) ?? 0) < 60_000) continue;
        checking.add(id);
        const check = async (): Promise<void> => {
          try {
            const s = await store.client.session(id);
            alive.set(id, Date.now());
            if (s.parentID === undefined) store.upsertSession(s);
          } catch (e) {
            if (!(e instanceof HttpError) || e.status !== 404) return;
            settings.closeSessions([id]);
            disposePage(id);
          } finally {
            checking.delete(id);
          }
        };
        void check();
      }
    }),
  );

  return (
    <Adw.ApplicationWindow
      application={app}
      title="opencode"
      defaultWidth={size?.[0] ?? 1100}
      defaultHeight={size?.[1] ?? 720}
      $={(self: Adw.ApplicationWindow) => {
        // connecté avant le gestionnaire de main.tsx : renvoyer true suspend la fermeture
        self.connect('close-request', () => confirmClose(self, settings, terminals.manager, dock));
        // Ctrl+Maj+J : terminaux intégrés (capturé avant le terminal ; Ctrl+J reste un saut de ligne pour lui)
        const keys = new Gtk.ShortcutController({ scope: Gtk.ShortcutScope.GLOBAL, propagationPhase: Gtk.PropagationPhase.CAPTURE });
        keys.add_shortcut(
          new Gtk.Shortcut({
            trigger: Gtk.ShortcutTrigger.parse_string('<Control><Shift>j'),
            action: Gtk.CallbackAction.new(() => {
              dock.toggle();
              return true;
            }),
          }),
        );
        self.add_controller(keys);
      }}
    >
      <Adw.ToastOverlay
        $={(self: Adw.ToastOverlay) => {
          overlay = self;
        }}
      >
        <Adw.NavigationSplitView
          sidebarWidthFraction={0.28}
          sidebarWidthUnit={Adw.LengthUnit.PX}
          minSidebarWidth={240}
          maxSidebarWidth={340}
          sidebar={asPage(
            Sidebar({
              store,
              settings,
              projects: visibleProjects,
              select,
              shown,
              allProjects,
              terminals,
              unseenFailures: tasks.unseen,
              tasks: tasks.tasks,
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
                extensions: (from, path) => openExtensions(from, store.client, path),
                reloadConfig: (from, p) => reloadProjectConfig(from, store.client, p.path, p.working, actions.toast),
                toggleFavorite: (path) => settings.toggleFavorite(path),
                newSession: (dir) => actions.newSession(dir),
                attach: (dir) => actions.attach(dir),
                toast: (m) => actions.toast(m),
                tasks: { store, monitor: tasks, toast: (m) => actions.toast(m) },
                openTasksWindow: (page) => app.activate_action('tasks', new GLib.Variant('s', page)),
                settings,
              },
            }),
          )}
          content={new Adw.NavigationPage({ title: 'opencode', child: dock.widget })}
          $={(self: Adw.NavigationSplitView) => {
            split = self;
            makeSidebarResizable(self, settings);
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
