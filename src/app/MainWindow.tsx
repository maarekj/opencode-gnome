// Fenêtre principale : projets (barre latérale) -> sessions du projet, synchronisés en direct.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { createComputed, createState, onCleanup } from 'gnim';
import { errorMessage, HttpError } from '../shared/errors.ts';
import { esc } from '../shared/format.ts';
import type { Session } from '../shared/schemas.ts';
import { prettyPath, type ProjectView, type Store } from '../shared/store.ts';
import { attachCommand, openTerminal, openTerminalArgv } from '../shared/terminal.ts';
import { createConversationPage, sessionTag, subagentTag, type ConversationPageHandle } from './ConversationPage.tsx';
import type { Settings } from '../shared/settings.ts';
import { openExtensions } from './ExtensionsDialog.ts';
import { reloadProjectConfig } from './ReloadConfig.ts';
import { type TasksMonitor } from './TasksWindow.tsx';
import { TerminalManager } from '../shared/terminals.ts';
import { type TerminalContext } from './TerminalBar.tsx';
import { TerminalDock } from './TerminalPanel.tsx';
import { Sidebar } from './Sidebar.tsx';
import { openSearch } from './SearchDialog.ts';
import { initVoice, escapeStopsVoice } from './Voice.ts';
import { SearchIndex } from '../shared/search.ts';
import { descendantsOf } from '../shared/projecttree.ts';
import { SessionsPage, type Actions, type ProjectTasksContext } from './SessionsPage.tsx';

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
  /** recherche dans toutes les conversations (Ctrl+Maj+F) */
  openSearch: () => void;
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
      .map((path): ProjectView => ({ key: `dir:${path}`, name: GLib.path_get_basename(path), path, vcs: false, sessions: [], working: 0, waiting: 0, unread: 0, updated: 0 }));
    return [...projects, ...missing];
  });
  /** Projets affichés dans la barre latérale selon le mode. */
  const visibleProjects = createComputed((): readonly ProjectView[] => {
    const { sidebarMode, favorites } = settings.data();
    const all = allProjects();
    if (sidebarMode === 'all') return all;
    // Favoris : ordre fixe, celui de la liste (changé seulement par glisser-déposer)
    const byPath = new Map(all.map((p) => [p.path, p]));
    return favorites.flatMap((path) => {
      const p = byPath.get(path);
      return p === undefined ? [] : [p];
    });
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
    openSession: (id: string) => actions.openSession(id),
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
    // dossier de la session affichée (worktree compris), sinon racine du projet
    newShell: (project, n) => {
      const id = shownSession();
      const dir = (id === null ? undefined : store.session(id)?.directory) ?? project;
      const cwd = GLib.file_test(dir, GLib.FileTest.IS_DIR) ? dir : project;
      return {
        key: `shell:${GLib.get_monotonic_time()}`,
        title: n === 1 ? 'Shell' : `Shell ${n}`,
        tooltip: `${GLib.path_get_basename(shell)} dans ${prettyPath(cwd)}`,
        icon: 'utilities-terminal-symbolic',
        argv: [shell],
        cwd,
        external: () => {
          try {
            const { terminal, terminalCommand } = settings.data.peek();
            openTerminalArgv([shell], cwd, { terminal, command: terminalCommand });
          } catch (e) {
            toast(errorMessage(e));
          }
        },
      };
    },
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
      // session affichée : la dernière session ouverte du projet dans l'ordre de la barre latérale,
      // sinon la liste du projet
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
  /** index de la recherche dans les conversations (fichier en cache, mis à jour à l'ouverture) */
  const searchIndex = new SearchIndex(store.client);
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
    openSearch: () => {
      if (win === null) return;
      openSearch(win, {
        index: searchIndex,
        projects: () => allProjects.peek(),
        project: null,
        open: (sessionID, messageID, partID) => {
          actions.openSession(sessionID);
          if (messageID !== null) pages.get(sessionID)?.reveal(messageID, partID ?? undefined);
        },
      });
    },
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

  // Lu / non lu : une session dont l'agent vient de finir de répondre est « non lue » tant
  // qu'elle n'a pas été affichée dans la fenêtre active (persistant dans les réglages).
  let win: Gtk.Window | null = null;
  /** session affichée et vue (fenêtre active) */
  const seen = (): string | null => (win?.isActive === true ? shownSession() : null);
  const markSeen = (): void => {
    const id = seen();
    if (id !== null) settings.setUnread(id, false);
  };
  nav.connect('notify::visible-page', markSeen);
  const syncUnread = (): void => store.setUnread(new Set(settings.data.peek().unread));
  syncUnread();
  onCleanup(settings.data.subscribe(syncUnread));
  let previous: Map<string, string> | null = null;
  onCleanup(
    store.projects.subscribe(() => {
      if (store.connection.peek().state !== 'connected') return;
      const now = new Map(store.projects.peek().flatMap((p) => p.sessions.map((v) => [v.session.id, v.activity] as const)));
      const before = previous;
      previous = now;
      // premier chargement : état de référence (les non-lues persistantes restent)
      if (before === null) return;
      for (const [id, activity] of now) {
        const was = before.get(id) ?? 'idle';
        if (was === activity) continue;
        // fin d'un tour de l'agent : non lue, sauf si elle est sous les yeux
        if (activity === 'idle' && (was === 'busy' || was === 'retry')) settings.setUnread(id, seen() !== id);
        // nouveau tour (message envoyé d'ici ou de la console) : la réponse précédente a été lue
        else if (activity === 'busy') settings.setUnread(id, false);
      }
      // sessions supprimées : retirées
      const gone = settings.data.peek().unread.filter((id) => !now.has(id) && before.has(id));
      for (const id of gone) settings.setUnread(id, false);
    }),
  );

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
        // retour sur la fenêtre : la session affichée est vue
        win = self;
        self.connect('notify::is-active', markSeen);
        // voix : messages (téléchargements, erreurs) dans cette fenêtre ; Échap arrête la lecture
        initVoice(settings, toast);
        escapeStopsVoice(self);
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
                // ajout : ses sous-projets du moment avec lui
                toggleFavorite: (path) => settings.toggleFavorite(path, descendantsOf(path, allProjects.peek().map((p) => p.path))),
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
