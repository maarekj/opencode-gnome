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

export const SettingsData = z.object({
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
  /** terminal : nom connu (`ptyxis`…), `custom` (commande libre) ; absent = automatique */
  terminal: z.optional(z.string()),
  /** commande du terminal personnalisé (préfixe argv, ex. `foot -e`) */
  terminalCommand: z.optional(z.string()),
  /** modèle par défaut des sessions sans modèle (`fournisseur/modèle`) ; absent = automatique */
  defaultModel: z.optional(z.string()),
  /** niveau de raisonnement par défaut associé au modèle par défaut */
  defaultVariant: z.optional(z.string()),
});
export type SettingsData = z.output<typeof SettingsData>;

const DEFAULTS: SettingsData = { terminals: {}, favorites: [], sidebarMode: 'all', openSessions: [], collapsed: [], sidebarWidth: 0, showTools: true, fontScale: 100, maxWidth: 860 };

export const settingsPath = (): string => GLib.build_filenamev([GLib.get_user_config_dir(), 'opencode-gnome', 'settings.json']);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function read(path: string): SettingsData {
  try {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok) return DEFAULTS;
    const parsed = SettingsData.safeParse(JSON.parse(decoder.decode(bytes)));
    return parsed.success ? parsed.data : DEFAULTS;
  } catch {
    return DEFAULTS; // absent ou illisible
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
    const [data, set] = createState<SettingsData>(read(path));
    this.data = data;
    this.#set = set;
  }

  /** Recharge le fichier quand un autre processus le modifie. */
  watch(): void {
    if (this.#monitor !== null) return;
    this.#monitor = Gio.File.new_for_path(this.#path).monitor_file(Gio.FileMonitorFlags.NONE, null);
    this.#monitor.connect('changed', (_m: Gio.FileMonitor, _f: Gio.File, _o: Gio.File | null, event: Gio.FileMonitorEvent) => {
      if (event !== Gio.FileMonitorEvent.CHANGES_DONE_HINT && event !== Gio.FileMonitorEvent.CREATED) return;
      const next = read(this.#path);
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
  setOptional(key: 'terminal' | 'terminalCommand' | 'defaultModel' | 'defaultVariant', value: string | undefined): void {
    if (this.data.peek()[key] === value) return;
    this.update((d) => {
      const { [key]: _old, ...rest } = d;
      return value === undefined ? rest : { ...rest, [key]: value };
    });
  }

  setNumber(key: 'fontScale' | 'maxWidth' | 'sidebarWidth', value: number): void {
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
