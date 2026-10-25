// Terminal intégré (VTE) : panneau à onglets sous la zone principale, un par projet.
// Onglets : shell du projet, terminal persistant (zellij attach : fermer l'onglet détache),
// session opencode (opencode attach). Chaque onglet peut être rouvert dans le terminal externe.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import type VteNs from 'gi://Vte?version=3.91';
import { createState, type Accessor } from 'gnim';
import type { Settings } from '../shared/settings.ts';

/** VTE est optionnel : sans lui, les terminaux s'ouvrent dans le terminal externe. */
let Vte: typeof VteNs | null = null;
try {
  Vte = (await import('gi://Vte?version=3.91')).default;
} catch (e) {
  console.warn(`terminal intégré indisponible (VTE GTK 4) : ${String(e)}`);
}

export const integratedAvailable = (): boolean => Vte !== null;

/** Onglet à ouvrir. */
export interface TerminalTab {
  /** identifiant stable : un onglet existant de même clé est simplement affiché */
  readonly key: string;
  readonly title: string;
  readonly tooltip?: string;
  readonly icon?: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  /** même commande dans le terminal externe */
  readonly external: () => void;
}

/** Palette « Adwaita » de GNOME Console. */
const PALETTE = [
  '#241f31', '#c01c28', '#2ec27e', '#f5c211', '#1e78e4', '#9841bb', '#0ab9dc', '#c0bfbc',
  '#5e5c64', '#ed333b', '#57e389', '#f8e45c', '#51a1ff', '#c061cb', '#4fd2fd', '#f6f5f4',
];

const rgba = (s: string): Gdk.RGBA => {
  const c = new Gdk.RGBA();
  c.parse(s);
  return c;
};

/** Police à chasse fixe de GNOME, taille comprise (ex. « Adwaita Mono 11 »). */
function monospaceFont(): Pango.FontDescription {
  try {
    const source = Gio.SettingsSchemaSource.get_default();
    if ((source?.lookup('org.gnome.desktop.interface', true) ?? null) !== null) {
      return Pango.FontDescription.from_string(new Gio.Settings({ schemaId: 'org.gnome.desktop.interface' }).get_string('monospace-font-name'));
    }
  } catch {
    // schéma absent : police par défaut
  }
  return Pango.FontDescription.from_string('Monospace 11');
}

/** Terminal sombre : réglage du terminal, sinon thème effectif de l'application. */
const terminalDark = (settings: Settings): boolean => {
  const t = settings.data.peek().terminalTheme;
  return t === 'system' ? Adw.StyleManager.get_default().dark : t === 'dark';
};

function applyColors(term: VteNs.Terminal, settings: Settings): void {
  const dark = terminalDark(settings);
  term.set_colors(rgba(dark ? '#ffffff' : '#000000'), rgba(dark ? '#1e1e1e' : '#ffffff'), PALETTE.map((c) => rgba(c)));
}

interface Tab {
  readonly spec: TerminalTab;
  readonly page: Adw.TabPage;
  readonly term: VteNs.Terminal;
}

/** libération d'un terminal : abonnements, processus */
const disposers = new WeakMap<VteNs.Terminal, () => void>();

/** pid du processus de chaque terminal (arrêté à la fermeture de l'onglet, sans attendre le GC) */
const pids = new WeakMap<VteNs.Terminal, number>();

function hangup(term: VteNs.Terminal): void {
  const pid = pids.get(term);
  if (pid === undefined) return;
  pids.delete(term);
  try {
    GLib.spawn_async(null, ['kill', '-HUP', String(pid)], null, GLib.SpawnFlags.SEARCH_PATH, null);
  } catch {
    // processus déjà terminé
  }
}

/** Crée le terminal et lance la commande ; `exited` : commande terminée sans erreur. */
function createTerminal(V: typeof VteNs, settings: Settings, spec: TerminalTab, exited: () => void): VteNs.Terminal {
  const term = new V.Terminal({ hexpand: true, vexpand: true, scrollOnOutput: false, scrollOnKeystroke: true, pointerAutohide: true, allowHyperlink: true });
  term.set_scrollback_lines(10_000);
  term.set_font(monospaceFont());
  // couleurs relues au changement de thème de l'application ou du réglage du terminal
  let dark = terminalDark(settings);
  applyColors(term, settings);
  const refresh = (): void => {
    if (terminalDark(settings) === dark) return;
    dark = !dark;
    applyColors(term, settings);
  };
  const style = Adw.StyleManager.get_default();
  const handler = style.connect('notify::dark', refresh);
  const unsubscribe = settings.data.subscribe(refresh);
  // libération explicite à la fermeture de l'onglet : ces abonnements gardent le terminal vivant,
  // 'destroy' n'arriverait jamais (#67)
  let disposed = false;
  disposers.set(term, () => {
    if (disposed) return;
    disposed = true;
    style.disconnect(handler);
    unsubscribe();
    hangup(term);
  });

  // Ctrl+Maj+C / V : copier / coller ; Ctrl+plus / moins / 0 : zoom
  const keys = new Gtk.EventControllerKey({ propagationPhase: Gtk.PropagationPhase.CAPTURE });
  keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number, _code: number, state: Gdk.ModifierType) => {
    const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
    const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
    if (!ctrl) return false;
    const key = Gdk.keyval_to_lower(keyval);
    if (shift && key === Gdk.KEY_c) {
      term.copy_clipboard_format(V.Format.TEXT);
      return true;
    }
    if (shift && key === Gdk.KEY_v) {
      term.paste_clipboard();
      return true;
    }
    if (key === Gdk.KEY_plus || key === Gdk.KEY_equal || key === Gdk.KEY_KP_Add) term.fontScale = Math.min(3, term.fontScale * 1.1);
    else if (key === Gdk.KEY_minus || key === Gdk.KEY_KP_Subtract) term.fontScale = Math.max(0.5, term.fontScale / 1.1);
    else if (key === Gdk.KEY_0 || key === Gdk.KEY_KP_0) term.fontScale = 1;
    else return false;
    return true;
  });
  term.add_controller(keys);

  term.connect('child-exited', (_t: VteNs.Terminal, status: number) => {
    pids.delete(term);
    if (status === 0) {
      exited();
      return;
    }
    // échec : message laissé visible, Entrée ferme l'onglet
    term.feed(`\r\n\u001B[2m[Processus terminé (${(status & 0x7f) === 0 ? `code ${status >> 8}` : `signal ${status & 0x7f}`}) — Entrée pour fermer]\u001B[0m`);
    term.inputEnabled = false;
    const close = new Gtk.EventControllerKey();
    close.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number) => {
      if (keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) return false;
      exited();
      return true;
    });
    term.add_controller(close);
  });

  term.spawn_async(
    V.PtyFlags.DEFAULT,
    GLib.file_test(spec.cwd, GLib.FileTest.IS_DIR) ? spec.cwd : GLib.get_home_dir(),
    [...spec.argv],
    ['COLORTERM=truecolor', 'TERM_PROGRAM=opencode-gnome'],
    GLib.SpawnFlags.SEARCH_PATH,
    null,
    -1,
    null,
    (_t: VteNs.Terminal, pid: number, error: GLib.Error | null) => {
      if (error === null && pid > 0) pids.set(term, pid);
      if (error !== null) term.feed(`\u001B[31mLancement impossible : ${error.message}\u001B[0m\r\n`);
    },
  );
  return term;
}

/** Onglets d'un projet. */
interface ProjectPanel {
  readonly widget: Gtk.Box;
  readonly size: () => number;
  readonly selected: () => Tab | null;
  readonly open: (spec: TerminalTab) => Tab;
  /** nombre d'onglets dont la clé commence par `prefix` (numérotation des shells) */
  readonly count: (prefix: string) => number;
}

function projectPanel(V: typeof VteNs, settings: Settings, actions: Gtk.Widget, emptied: () => void): ProjectPanel {
  const view = new Adw.TabView({ vexpand: true });
  const tabs = new Map<string, Tab>();
  const byPage = new Map<Adw.TabPage, Tab>();
  const bar = new Adw.TabBar({ view, autohide: false, expandTabs: false, endActionWidget: actions });
  const widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, cssClasses: ['terminal-panel'] });
  widget.append(bar);
  widget.append(view);
  view.connect('close-page', (_v: Adw.TabView, page: Adw.TabPage) => {
    const tab = byPage.get(page);
    if (tab !== undefined) {
      byPage.delete(page);
      tabs.delete(tab.spec.key);
      disposers.get(tab.term)?.();
      disposers.delete(tab.term);
    }
    view.close_page_finish(page, true);
    if (view.nPages === 0) emptied();
    return true; // fermeture confirmée ici (close_page_finish)
  });
  return {
    widget,
    size: () => tabs.size,
    selected: () => {
      const page = view.selectedPage;
      return page === null ? null : (byPage.get(page) ?? null);
    },
    open: (spec) => {
      let tab = tabs.get(spec.key);
      if (tab === undefined) {
        const term = createTerminal(V, settings, spec, () => {
          const t = tabs.get(spec.key);
          if (t !== undefined && t.term === term) view.close_page(t.page);
        });
        const page = view.append(new Gtk.ScrolledWindow({ child: term, hscrollbarPolicy: Gtk.PolicyType.NEVER, cssClasses: ['terminal-scroll'] }));
        page.title = spec.title;
        page.tooltip = spec.tooltip ?? spec.title;
        if (spec.icon !== undefined) page.icon = Gio.ThemedIcon.new(spec.icon);
        tab = { spec, page, term };
        tabs.set(spec.key, tab);
        byPage.set(page, tab);
      }
      view.selectedPage = tab.page;
      return tab;
    },
    count: (prefix) => [...tabs.keys()].filter((k) => k.startsWith(prefix)).length,
  };
}

/**
 * Zone principale + panneau des terminaux (Gtk.Paned vertical). Le panneau affiché est celui du
 * projet courant ; il est masqué quand le projet n'a aucun onglet ou que l'utilisateur le replie.
 */
export class TerminalDock {
  readonly widget: Gtk.Paned;
  /** panneau visible pour le projet courant */
  readonly shown: Accessor<boolean>;
  readonly #setShown: (v: boolean) => void;
  readonly #stack = new Gtk.Stack({ transitionType: Gtk.StackTransitionType.NONE, vexpand: true });
  readonly #panels = new Map<string, ProjectPanel>();
  /** projets dont le panneau est déplié */
  readonly #open = new Set<string>();
  readonly #content: Gtk.Widget;
  readonly #settings: Settings;
  readonly #newShell: (project: string, n: number) => TerminalTab;
  #project: string | null = null;
  #maximized = false;
  #saveTimer = 0;
  #placing = false;

  constructor(opts: { content: Gtk.Widget; settings: Settings; newShell: (project: string, n: number) => TerminalTab }) {
    this.#content = opts.content;
    this.#settings = opts.settings;
    this.#newShell = opts.newShell;
    [this.shown, this.#setShown] = createState(false);
    this.widget = new Gtk.Paned({
      orientation: Gtk.Orientation.VERTICAL,
      startChild: opts.content,
      endChild: this.#stack,
      resizeStartChild: true,
      resizeEndChild: false,
      shrinkStartChild: false,
      shrinkEndChild: false,
      wideHandle: true,
    });
    this.#stack.visible = false;
    // hauteur du panneau mémorisée (après un glissement de la poignée)
    this.widget.connect('notify::position', () => {
      if (this.#placing || this.#animation !== null || this.#maximized || !this.#panelShown) return;
      if (this.#saveTimer !== 0) GLib.source_remove(this.#saveTimer);
      this.#saveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
        this.#saveTimer = 0;
        const h = this.widget.get_height() - this.widget.position;
        if (h > 60) this.#settings.setNumber('terminalPanelHeight', Math.round(h));
        return GLib.SOURCE_REMOVE;
      });
    });
  }

  /** Terminaux ouverts dans l'application (préférence + VTE disponible). */
  enabled(): boolean {
    return Vte !== null && this.#settings.data.peek().terminalIntegrated;
  }

  setProject(project: string | null): void {
    this.#project = project;
    this.#update();
  }

  /** Affiche (ou crée) l'onglet dans le panneau du projet et lui donne le focus. */
  open(project: string, spec: TerminalTab): void {
    const panel = this.#panel(project);
    if (panel === null) return;
    const tab = panel.open(spec);
    this.#open.add(project);
    if (this.#project !== project) this.#project = project;
    this.#update();
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      tab.term.grab_focus();
      return GLib.SOURCE_REMOVE;
    });
  }

  /** Nouveau shell dans le dossier du projet courant. */
  newShell(): void {
    const p = this.#project;
    if (p === null) return;
    const n = (this.#panels.get(p)?.count('shell:') ?? 0) + 1;
    this.open(p, this.#newShell(p, n));
  }

  /**
   * Affiche / masque le panneau du projet courant (sans onglet : ouvre un shell). Terminal
   * intégré désactivé : seuls les onglets déjà ouverts peuvent encore être affichés ou masqués.
   */
  toggle(): void {
    const p = this.#project;
    if (p === null) return;
    if ((this.#panels.get(p)?.size() ?? 0) === 0) {
      if (this.enabled()) this.newShell();
      return;
    }
    if (this.#open.has(p)) this.#open.delete(p);
    else this.#open.add(p);
    this.#update();
    if (this.#open.has(p)) this.#focusSelected();
  }

  #focusSelected(): void {
    const p = this.#project;
    const tab = p === null ? null : (this.#panels.get(p)?.selected() ?? null);
    if (tab !== null)
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        tab.term.grab_focus();
        return GLib.SOURCE_REMOVE;
      });
  }

  #panel(project: string): ProjectPanel | null {
    if (Vte === null) return null;
    let panel = this.#panels.get(project);
    if (panel === undefined) {
      panel = projectPanel(Vte, this.#settings, this.#actions(), () => {
        this.#open.delete(project);
        this.#update();
      });
      this.#panels.set(project, panel);
      this.#stack.add_named(panel.widget, project);
    }
    return panel;
  }

  /** Boutons à droite des onglets. */
  #actions(): Gtk.Widget {
    const box = new Gtk.Box({ spacing: 2, marginEnd: 4 });
    const button = (icon: string, tooltip: string, fn: () => void): Gtk.Button => {
      const b = new Gtk.Button({ iconName: icon, tooltipText: tooltip, cssClasses: ['flat'], valign: Gtk.Align.CENTER });
      b.connect('clicked', fn);
      box.append(b);
      return b;
    };
    button('list-add-symbolic', 'Nouveau shell dans le projet', () => this.newShell());
    button('window-new-symbolic', 'Ouvrir l’onglet dans le terminal externe', () => {
      const p = this.#project;
      const tab = p === null ? null : (this.#panels.get(p)?.selected() ?? null);
      tab?.spec.external();
    });
    const max = button('view-fullscreen-symbolic', 'Agrandir le panneau', () => {
      this.#maximized = !this.#maximized;
      this.#update();
    });
    const sync = (): void => {
      max.iconName = this.#maximized ? 'view-restore-symbolic' : 'view-fullscreen-symbolic';
      max.tooltipText = this.#maximized ? 'Réduire le panneau' : 'Agrandir le panneau';
    };
    this.#syncers.push(sync);
    button('go-bottom-symbolic', 'Masquer le panneau (Ctrl+Maj+J)', () => this.toggle());
    return box;
  }

  readonly #syncers: (() => void)[] = [];

  /** panneau affiché (ou en train de s'ouvrir) ; le stack reste visible pendant la fermeture animée */
  #panelShown = false;
  #animation: Adw.TimedAnimation | null = null;

  #update(): void {
    const p = this.#project;
    const panel = p === null ? undefined : this.#panels.get(p);
    const visible = p !== null && panel !== undefined && panel.size() > 0 && this.#open.has(p);
    if (visible) this.#stack.visibleChildName = p;
    const wasVisible = this.#panelShown;
    this.#panelShown = visible;
    if (!visible) this.#maximized = false;
    this.#content.visible = !(visible && this.#maximized);
    for (const s of this.#syncers) s();
    this.#setShown(visible);
    if (visible !== wasVisible) this.#slide(visible);
  }

  /** Hauteur cible du panneau : hauteur mémorisée, bornée par la place disponible. */
  #target(h: number): number {
    const panel = Math.min(Math.max(120, this.#settings.data.peek().terminalPanelHeight), h - 120);
    return Math.max(120, h - panel);
  }

  #setPosition(v: number): void {
    this.#placing = true;
    this.widget.position = Math.round(v);
    this.#placing = false;
  }

  /** Ouverture / fermeture du panneau en glissant depuis le bas (sans animation : immédiate). */
  #slide(opening: boolean): void {
    this.#animation?.pause();
    this.#animation = null;
    const h = this.widget.get_height();
    if (h <= 0 || !Adw.get_enable_animations(this.widget)) {
      this.widget.shrinkEndChild = false;
      this.#stack.visible = opening;
      if (opening) this.#place();
      return;
    }
    const from = this.#stack.visible ? this.widget.position : h;
    // pendant le glissement, le panneau peut descendre sous sa taille minimale
    this.widget.shrinkEndChild = true;
    this.#stack.visible = true;
    this.#setPosition(from);
    const anim = new Adw.TimedAnimation({
      widget: this.widget,
      valueFrom: from,
      valueTo: opening ? this.#target(h) : h,
      duration: 220,
      easing: opening ? Adw.Easing.EASE_OUT_CUBIC : Adw.Easing.EASE_IN_CUBIC,
      target: Adw.CallbackAnimationTarget.new((v: number) => this.#setPosition(v)),
    });
    anim.connect('done', () => {
      if (this.#animation !== anim) return;
      this.#animation = null;
      this.widget.shrinkEndChild = false;
      if (!opening) this.#stack.visible = false;
    });
    this.#animation = anim;
    anim.play();
  }

  /** Position de la poignée : hauteur mémorisée du panneau. */
  #place(): void {
    const apply = (): boolean => {
      const h = this.widget.get_height();
      if (h <= 0) return false;
      this.#setPosition(this.#target(h));
      return true;
    };
    if (!apply())
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        apply();
        return GLib.SOURCE_REMOVE;
      });
  }

  /** Bouton d'en-tête : affiche / masque le panneau. */
  toggleButton(): Gtk.ToggleButton {
    const b = new Gtk.ToggleButton({ iconName: 'og-terminal-panel-symbolic', tooltipText: 'Terminaux intégrés (Ctrl+Maj+J)', visible: this.enabled() });
    const unwatch = this.#settings.data.subscribe(() => {
      b.visible = this.enabled() || this.shown.peek();
    });
    b.connect('destroy', unwatch);
    let syncing = false;
    const sync = (): void => {
      syncing = true;
      b.active = this.shown.peek();
      syncing = false;
    };
    sync();
    const unsubscribe = this.shown.subscribe(sync);
    b.connect('destroy', unsubscribe);
    b.connect('toggled', () => {
      if (!syncing && b.active !== this.shown.peek()) this.toggle();
    });
    return b;
  }
}
