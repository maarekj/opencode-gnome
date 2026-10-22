// Fenêtre principale : projets (barre latérale) -> sessions du projet, synchronisés en direct.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { createComputed, createMemo, createState, onCleanup, With, type Accessor } from 'gnim';
import { errorMessage } from '../shared/errors.ts';
import { esc, fmtCost, fmtRelative } from '../shared/format.ts';
import { prettyPath, type ProjectView, type SessionView, type Store } from '../shared/store.ts';
import { attachCommand, openTerminal } from '../shared/terminal.ts';
import { createConversationPage, sessionTag } from './ConversationPage.tsx';
import { keyedListBox } from './KeyedBox.ts';

export const SERVER_UNIT = 'opencode-gnome-server.service';

interface Actions {
  toast: (message: string) => void;
  /** Ouvre opencode dans un terminal : sur une session, ou une nouvelle si `sessionID` est absent. */
  attach: (directory: string, sessionID?: string) => void;
  /** Affiche la conversation d'une session. */
  openSession: (sessionID: string) => void;
  /** Crée une session dans un répertoire et l'ouvre. */
  newSession: (directory: string) => void;
}

// ---------------------------------------------------------------- barre latérale

const plural = (n: number, one: string, many: string): string => `${n} ${n > 1 ? many : one}`;

/**
 * Projet de la barre latérale. Suffixes : spinner si l'agent travaille dans une session,
 * pastille orange avec le nombre de sessions qui attendent une réponse. Projets vides atténués.
 */
function ProjectRow({ project }: { project: ProjectView }): JSX.Element {
  const empty = project.sessions.length === 0;
  return (
    <Adw.ActionRow
      name={project.key}
      title={esc(project.name)}
      subtitle={esc(prettyPath(project.path))}
      subtitleLines={1}
      activatable
      cssClasses={empty ? ['dim-label'] : []}
      tooltipText={empty ? 'Aucune session' : ''}
    >
      <Gtk.Image $type="prefix" iconName="folder-symbolic" />
      {project.working > 0 ? <Adw.Spinner $type="suffix" tooltipText={plural(project.working, 'session en cours', 'sessions en cours')} /> : null}
      {project.waiting > 0 ? (
        <Gtk.Label
          $type="suffix"
          label={String(project.waiting)}
          valign={Gtk.Align.CENTER}
          cssClasses={['waiting-badge']}
          tooltipText={plural(project.waiting, 'session attend ta réponse', 'sessions attendent ta réponse')}
        />
      ) : null}
    </Adw.ActionRow>
  );
}

function startServer(): void {
  try {
    Gio.Subprocess.new(['systemctl', '--user', 'start', SERVER_UNIT], Gio.SubprocessFlags.NONE);
  } catch (e) {
    console.error(errorMessage(e));
  }
}

function Sidebar({ store, select }: { store: Store; select: (key: string) => void }): JSX.Element {
  const conn = store.connection;
  return (
    <Adw.NavigationPage title="Projets" tag="projects">
      <Adw.ToolbarView>
        <Adw.HeaderBar $type="top">
          <Gtk.Button $type="end" iconName="view-refresh-symbolic" tooltipText="Recharger" onClicked={() => void store.reload()} />
        </Adw.HeaderBar>
        <Adw.Banner
          $type="top"
          revealed={conn((c) => c.state === 'error')}
          title={conn((c) => (c.state === 'error' ? `Serveur opencode injoignable : ${c.message}` : ''))}
          buttonLabel="Démarrer"
          onButtonClicked={startServer}
        />
        <Gtk.ScrolledWindow vexpand hscrollbarPolicy={Gtk.PolicyType.NEVER}>
          <Gtk.ListBox
            cssClasses={['navigation-sidebar']}
            onRowActivated={(_self: Gtk.ListBox, row: Gtk.ListBoxRow) => {
              select(row.name);
            }}
            $={(self: Gtk.ListBox) => {
              onCleanup(keyedListBox(self, store.projects, (p) => `${p.key}|${p.working}|${p.waiting}|${p.sessions.length === 0}|${p.name}`, (p) => asWidget(ProjectRow({ project: p }))));
            }}
          />
        </Gtk.ScrolledWindow>
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
  const meta = [fmtRelative(updatedAt(view)), s.agent, s.model?.id, fmtCost(s.cost)].filter((x) => x !== undefined && x !== '').join('  ·  ');
  return (
    <Adw.ActionRow
      title={esc(s.title === '' ? 'Sans titre' : s.title)}
      subtitle={esc(meta)}
      activatable
      onActivated={() => actions.openSession(s.id)}
    >
      {activityIcon(view)}
      <Gtk.Button $type="suffix" iconName="utilities-terminal-symbolic" tooltipText="Ouvrir dans le terminal" valign={Gtk.Align.CENTER} cssClasses={['flat']} onClicked={() => actions.attach(s.directory, s.id)} />
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
}

export function MainWindow({ app, store, size, ready }: { app: Adw.Application; store: Store; size?: [number, number]; ready: (api: WindowApi) => void }): JSX.Element {
  const [selected, setSelected] = createState<string | null>(null);
  const current = createComputed(() => {
    const projects = store.projects();
    const key = selected();
    return projects.find((p) => p.key === key) ?? projects[0] ?? null;
  });

  let overlay: Adw.ToastOverlay | null = null;
  let split: Adw.NavigationSplitView | null = null;
  const nav = new Adw.NavigationView();

  const actions: Actions = {
    toast: (title) => overlay?.add_toast(new Adw.Toast({ title: esc(title), timeout: 4 })),
    attach: (directory, sessionID) => {
      try {
        openTerminal(attachCommand(store.client.url, directory, sessionID), GLib.file_test(directory, GLib.FileTest.IS_DIR) ? directory : GLib.get_home_dir());
      } catch (e) {
        actions.toast(errorMessage(e));
      }
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
      if (project !== undefined) setSelected(project.key);
      if (split !== null) split.showContent = true;
      const existing = nav.find_page(sessionTag(sessionID));
      if (existing !== null) {
        nav.pop_to_page(existing);
        return;
      }
      nav.pop_to_tag('sessions');
      nav.push(createConversationPage({ store, sessionID, nav, attach: actions.attach, toast: actions.toast }));
    },
  };


  const select = (key: string): void => {
    setSelected(key);
    nav.pop_to_tag('sessions');
    if (split !== null) split.showContent = true;
  };

  nav.add(asPage(SessionsPage({ store, current, actions })));
  ready({ openSession: actions.openSession });

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
          sidebar={asPage(Sidebar({ store, select }))}
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
