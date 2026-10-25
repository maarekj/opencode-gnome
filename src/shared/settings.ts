// Réglages locaux d'opencode-gnome (~/.config/opencode-gnome/settings.json), partagés avec
// l'extension. Jamais édités à la main : tout passe par l'interface. Rechargés si le fichier
// change (autre processus).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { createState, type Accessor } from 'gnim';
import * as z from 'zod/mini';

export const SidebarMode = z.enum(['favorites', 'all']);
export type SidebarMode = z.output<typeof SidebarMode>;

/** Terminal persistant d'un projet (session zellij). */
export const ProjectTerminal = z.object({
  /** identifiant stable (nom de la session zellij) */
  id: z.string(),
  name: z.string(),
  command: z.string(),
  /** répertoire de lancement ; absent = racine du projet */
  cwd: z.optional(z.string()),
});
export type ProjectTerminal = z.output<typeof ProjectTerminal>;

/** Apparence du rendu markdown des messages. */
export const MarkdownStyle = z.object({
  /** police du texte : celle de l'interface, à chasse fixe (police mono de GNOME) ou serif */
  font: z.prefault(z.enum(['system', 'mono', 'serif']), 'system'),
  /** espace entre les lignes d'un même paragraphe, en px */
  lineSpacing: z.prefault(z.number(), 2),
  /** espace entre les paragraphes (titres, listes, code : proportionnel), en px */
  paragraphSpacing: z.prefault(z.number(), 8),
  /** sober : sans couleur ; headings : titres colorés ; colorful : titres, puces, code, citations */
  colors: z.prefault(z.enum(['sober', 'headings', 'colorful']), 'sober'),
});
export type MarkdownStyle = z.output<typeof MarkdownStyle>;
export const DEFAULT_MARKDOWN_STYLE: MarkdownStyle = { font: 'system', lineSpacing: 2, paragraphSpacing: 8, colors: 'sober' };

/** Lien web épinglé d'un projet ; l'adresse peut contenir des variables ($PORT_WEB…). */
export const ProjectLink = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
});
export type ProjectLink = z.output<typeof ProjectLink>;

export const SettingsData = z.object({
  /** liens épinglés : chemin du projet -> liens */
  links: z.prefault(z.record(z.string(), z.array(ProjectLink)), {}),
  /** navigateur de chaque projet (identifiant .desktop) ; absent = navigateur par défaut */
  browsers: z.prefault(z.record(z.string(), z.string()), {}),
  /** IDE de chaque projet : chemin du projet -> identifiant .desktop */
  ides: z.prefault(z.record(z.string(), z.string()), {}),
  /** IDE par défaut (projets sans réglage) ; absent = premier détecté */
  defaultIde: z.optional(z.string()),
  /** apparence du rendu markdown */
  markdown: z.prefault(MarkdownStyle, DEFAULT_MARKDOWN_STYLE),
  /** terminaux persistants : chemin du projet -> terminaux */
  terminals: z.prefault(z.record(z.string(), z.array(ProjectTerminal)), {}),
  /** chemins des projets favoris */
  favorites: z.prefault(z.array(z.string()), []),
  /** mode de la barre latérale */
  sidebarMode: z.prefault(SidebarMode, 'all'),
  /** sessions ouvertes (onglets de la barre latérale), dans l'ordre d'ouverture */
  openSessions: z.prefault(z.array(z.string()), []),
  /** projets repliés dans la barre latérale (clés de projet) */
  collapsed: z.prefault(z.array(z.string()), []),
  /** largeur de la barre latérale en px (0 = automatique) */
  sidebarWidth: z.prefault(z.number(), 0),
  /** taille du texte de la conversation, en % */
  fontScale: z.prefault(z.number(), 100),
  /** largeur maximale de la conversation en px (0 = toute la largeur) */
  maxWidth: z.prefault(z.number(), 860),
  /** afficher les appels d'outils dans les conversations */
  showTools: z.prefault(z.boolean(), true),
  /** notifications de bureau (session terminée, question, permission, erreur) */
  notifications: z.prefault(z.boolean(), true),
  /** son joué avec les notifications */
  notificationSound: z.prefault(z.boolean(), true),
  /** terminal : nom connu (`ptyxis`…), `custom` (commande libre) ; absent = automatique */
  terminal: z.optional(z.string()),
  /** commande du terminal personnalisé (préfixe argv, ex. `foot -e`) */
  terminalCommand: z.optional(z.string()),
  /** terminaux ouverts dans le panneau intégré (VTE) plutôt que dans le terminal externe */
  terminalIntegrated: z.prefault(z.boolean(), true),
  /** thème de l'application : système, jour ou nuit */
  appTheme: z.prefault(z.enum(['system', 'light', 'dark']), 'system'),
  /** thème du terminal intégré : comme l'application, jour ou nuit */
  terminalTheme: z.prefault(z.enum(['system', 'light', 'dark']), 'system'),
  /** hauteur du panneau des terminaux intégrés, en px */
  terminalPanelHeight: z.prefault(z.number(), 300),
  /** modèle par défaut des sessions sans modèle (`fournisseur/modèle`) ; absent = automatique */
  defaultModel: z.optional(z.string()),
  /** niveau de raisonnement par défaut associé au modèle par défaut */
  defaultVariant: z.optional(z.string()),
});
export type SettingsData = z.output<typeof SettingsData>;
export type Theme = SettingsData['appTheme'];

const DEFAULTS: SettingsData = { links: {}, browsers: {}, ides: {}, markdown: DEFAULT_MARKDOWN_STYLE, terminals: {}, favorites: [], sidebarMode: 'all', openSessions: [], collapsed: [], sidebarWidth: 0, showTools: true, notifications: true, notificationSound: true, fontScale: 100, maxWidth: 860, terminalIntegrated: true, terminalPanelHeight: 300, appTheme: 'system', terminalTheme: 'system' };

export const settingsPath = (): string => GLib.build_filenamev([GLib.get_user_config_dir(), 'opencode-gnome', 'settings.json']);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Valide les réglages champ par champ : un champ invalide reprend sa valeur par défaut au lieu
 * de remettre tous les réglages à zéro (#64).
 */
export function parseSettings(raw: unknown): SettingsData {
  const input: Record<string, unknown> = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...raw } : {};
  for (const [key, schema] of Object.entries(SettingsData.def.shape)) {
    if (!(key in input)) continue;
    if (!z.safeParse(schema, input[key]).success) delete input[key];
  }
  const parsed = SettingsData.safeParse(input);
  return parsed.success ? parsed.data : DEFAULTS;
}

/** Réglages du fichier ; `undefined` s'il est absent, `null` s'il est illisible (JSON invalide…). */
function read(path: string): SettingsData | null | undefined {
  let text: string;
  try {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok) return undefined;
    text = decoder.decode(bytes);
  } catch {
    return undefined; // absent
  }
  try {
    return parseSettings(JSON.parse(text));
  } catch {
    console.error(`réglages illisibles, ignorés : ${path}`);
    return null;
  }
}

export class Settings {
  readonly data: Accessor<SettingsData>;
  readonly #set: (v: SettingsData) => void;
  readonly #path: string;
  #monitor: Gio.FileMonitor | null = null;
  /** contenu écrit par ce processus (ignoré par le moniteur) */
  #written = '';

  constructor(path = settingsPath()) {
    this.#path = path;
    const [data, set] = createState<SettingsData>(read(path) ?? DEFAULTS);
    this.data = data;
    this.#set = set;
  }

  /** Recharge le fichier quand un autre processus le modifie. */
  watch(): void {
    if (this.#monitor !== null) return;
    this.#monitor = Gio.File.new_for_path(this.#path).monitor_file(Gio.FileMonitorFlags.NONE, null);
    this.#monitor.connect('changed', (_m: Gio.FileMonitor, _f: Gio.File, _o: Gio.File | null, event: Gio.FileMonitorEvent) => {
      if (event !== Gio.FileMonitorEvent.CHANGES_DONE_HINT && event !== Gio.FileMonitorEvent.CREATED) return;
      // illisible (écriture en cours d'un autre processus…) ou supprimé : état courant conservé
      const next = read(this.#path);
      if (next === null || next === undefined) return;
      if (JSON.stringify(next) !== this.#written) this.#set(next);
    });
  }

  update(fn: (d: SettingsData) => SettingsData): void {
    const next = fn(this.data.peek());
    this.#set(next);
    const json = JSON.stringify(next);
    this.#written = json;
    try {
      GLib.mkdir_with_parents(GLib.path_get_dirname(this.#path), 0o700);
      GLib.file_set_contents(this.#path, encoder.encode(`${JSON.stringify(next, null, 2)}\n`));
    } catch (e) {
      console.error(`réglages non enregistrés : ${String(e)}`);
    }
  }

  isFavorite(path: string): boolean {
    return this.data.peek().favorites.includes(path);
  }

  toggleFavorite(path: string): void {
    this.update((d) => ({ ...d, favorites: d.favorites.includes(path) ? d.favorites.filter((p) => p !== path) : [...d.favorites, path] }));
  }

  /** Modifie un réglage optionnel (`undefined` = valeur automatique, retirée du fichier). */
  setOptional(key: 'terminal' | 'terminalCommand' | 'defaultModel' | 'defaultVariant' | 'defaultIde', value: string | undefined): void {
    if (this.data.peek()[key] === value) return;
    this.update((d) => {
      const { [key]: _old, ...rest } = d;
      return value === undefined ? rest : { ...rest, [key]: value };
    });
  }

  /** Ajoute ou remplace (même id) un lien du projet. */
  saveLink(project: string, link: ProjectLink): void {
    this.update((d) => {
      const list = d.links[project] ?? [];
      const next = list.some((l) => l.id === link.id) ? list.map((l) => (l.id === link.id ? link : l)) : [...list, link];
      return { ...d, links: { ...d.links, [project]: next } };
    });
  }

  removeLink(project: string, id: string): void {
    this.update((d) => {
      const { [project]: list = [], ...others } = d.links;
      const next = list.filter((l) => l.id !== id);
      return { ...d, links: next.length === 0 ? others : { ...others, [project]: next } };
    });
  }

  /** Navigateur du projet (`undefined` : navigateur par défaut du système). */
  setProjectBrowser(project: string, id: string | undefined): void {
    this.update((d) => {
      const { [project]: _old, ...rest } = d.browsers;
      return { ...d, browsers: id === undefined ? rest : { ...rest, [project]: id } };
    });
  }

  /** IDE du projet (`undefined` : celui des préférences). */
  setProjectIde(project: string, id: string | undefined): void {
    this.update((d) => {
      const { [project]: _old, ...rest } = d.ides;
      return { ...d, ides: id === undefined ? rest : { ...rest, [project]: id } };
    });
  }

  setMarkdownStyle(patch: Partial<MarkdownStyle>): void {
    this.update((d) => ({ ...d, markdown: { ...d.markdown, ...patch } }));
  }

  setNumber(key: 'fontScale' | 'maxWidth' | 'sidebarWidth' | 'terminalPanelHeight', value: number): void {
    if (this.data.peek()[key] !== value) this.update((d) => ({ ...d, [key]: value }));
  }

  /** Ajoute une session aux sessions ouvertes (à la fin), si elle n'y est pas. */
  openSession(id: string): void {
    if (!this.data.peek().openSessions.includes(id)) this.update((d) => ({ ...d, openSessions: [...d.openSessions, id] }));
  }

  closeSessions(ids: readonly string[]): void {
    if (ids.some((id) => this.data.peek().openSessions.includes(id))) this.update((d) => ({ ...d, openSessions: d.openSessions.filter((x) => !ids.includes(x)) }));
  }

  setCollapsed(key: string, collapsed: boolean): void {
    const has = this.data.peek().collapsed.includes(key);
    if (has === collapsed) return;
    this.update((d) => ({ ...d, collapsed: collapsed ? [...d.collapsed, key] : d.collapsed.filter((k) => k !== key) }));
  }

  setNotifications(on: boolean): void {
    if (this.data.peek().notifications !== on) this.update((d) => ({ ...d, notifications: on }));
  }

  setNotificationSound(on: boolean): void {
    if (this.data.peek().notificationSound !== on) this.update((d) => ({ ...d, notificationSound: on }));
  }

  setTheme(key: 'appTheme' | 'terminalTheme', value: Theme): void {
    if (this.data.peek()[key] !== value) this.update((d) => ({ ...d, [key]: value }));
  }

  setTerminalIntegrated(on: boolean): void {
    if (this.data.peek().terminalIntegrated !== on) this.update((d) => ({ ...d, terminalIntegrated: on }));
  }

  setShowTools(show: boolean): void {
    if (this.data.peek().showTools !== show) this.update((d) => ({ ...d, showTools: show }));
  }

  /** Ajoute ou remplace (même id) un terminal du projet. */
  saveTerminal(project: string, terminal: ProjectTerminal): void {
    this.update((d) => {
      const list = d.terminals[project] ?? [];
      const next = list.some((t) => t.id === terminal.id) ? list.map((t) => (t.id === terminal.id ? terminal : t)) : [...list, terminal];
      return { ...d, terminals: { ...d.terminals, [project]: next } };
    });
  }

  removeTerminal(project: string, id: string): void {
    this.update((d) => {
      const { [project]: list = [], ...others } = d.terminals;
      const next = list.filter((t) => t.id !== id);
      return { ...d, terminals: next.length === 0 ? others : { ...others, [project]: next } };
    });
  }

  setSidebarMode(mode: SidebarMode): void {
    if (this.data.peek().sidebarMode !== mode) this.update((d) => ({ ...d, sidebarMode: mode }));
  }
}
