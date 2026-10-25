// Page d'un projet : tâches planifiées et liste des sessions (recherche, actions).
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import { createComputed, createMemo, createState, onCleanup, With, type Accessor } from 'gnim';
import { errorMessage } from '../shared/errors.ts';
import { esc, fmtCost, fmtRelative, fmtStamp } from '../shared/format.ts';
import type { Session } from '../shared/schemas.ts';
import { prettyPath, type ProjectView, type SessionView, type Store } from '../shared/store.ts';
import { attachContextMenu } from './ContextMenu.ts';
import { openExtensions } from './ExtensionsDialog.ts';
import { openFolder } from './OpenFolder.ts';
import { IdeButton } from './Ide.ts';
import { openGitWindow } from './GitWindow.tsx';
import { reloadProjectConfig } from './ReloadConfig.ts';
import { keyedListBox } from './KeyedBox.ts';
import { confirmDelete, openEditor, STATUS, type EditorContext, type TaskView } from './TasksWindow.tsx';
import { describeSchedule, isManual, removeTask, saveTask, startRun, stopRun } from '../shared/tasks.ts';
import { TerminalBar, type TerminalContext } from './TerminalBar.tsx';
import { attachSessionMenu, deleteButton, type SessionActions } from './SessionMenu.ts';
import { asWidget, normalize } from './Sidebar.tsx';

export interface Actions {
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
export interface ProjectTasksContext {
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


export function SessionsPage({
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

