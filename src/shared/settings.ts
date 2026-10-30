// Réglages locaux d'opencode-gnome (~/.config/opencode-gnome/settings.json), partagés avec
// la CLI `ocg` (terminaux, liens). Écrits sous verrou ; rechargés si le fichier change (autre
// processus).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { createState, type Accessor } from 'gnim';
import * as z from 'zod/mini';
import { LayoutEntry, moveEntry, normalizeLayout } from './layout.ts';
import { withLock } from './lock.ts';
import { moveChild } from './projecttree.ts';

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

/** Voix : dictée (STT) et lecture à voix haute (TTS). */
export const VoiceSettings = z.object({
  /** moteur de dictée : whisper.cpp local ou API OpenAI */
  stt: z.prefault(z.enum(['whisper', 'openai']), 'whisper'),
  /** modèle whisper.cpp (téléchargé au premier usage) */
  whisperModel: z.prefault(z.enum(['base', 'small', 'medium', 'large-v3-turbo']), 'small'),
  /** moteur de lecture : Piper local, speech-dispatcher (voix du système) ou API OpenAI */
  tts: z.prefault(z.enum(['piper', 'speechd', 'openai']), 'piper'),
  /** voix Piper (identifiant rhasspy/piper-voices, téléchargée au premier usage) */
  piperVoice: z.prefault(z.string(), 'fr_FR-siwis-medium'),
  /** voix OpenAI */
  openaiVoice: z.prefault(z.string(), 'alloy'),
  /** langue (code ISO 639-1) */
  language: z.prefault(z.string(), 'fr'),
  /** vitesse de lecture (1 = normale) */
  rate: z.prefault(z.number(), 1),
  /** envoyer le prompt dès la fin de la dictée */
  autoSend: z.prefault(z.boolean(), false),
  /** clé API OpenAI ; absente = variable OPENAI_API_KEY */
  openaiKey: z.optional(z.string()),
});
export type VoiceSettings = z.output<typeof VoiceSettings>;
export const DEFAULT_VOICE: VoiceSettings = { stt: 'whisper', whisperModel: 'small', tts: 'piper', piperVoice: 'fr_FR-siwis-medium', openaiVoice: 'alloy', language: 'fr', rate: 1, autoSend: false };

/** Lien web épinglé d'un projet ; l'adresse peut contenir des variables ($PORT_WEB…). */
export const ProjectLink = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
});
export type ProjectLink = z.output<typeof ProjectLink>;

/** Process manager devenv d'un dossier du projet (`devenv up`, services) (#147). */
export const ProjectDevenv = z.object({
  id: z.string(),
  name: z.string(),
  /** dossier contenant devenv.nix, relatif au projet ; absent = racine du projet */
  cwd: z.optional(z.string()),
  /** services vus lors du dernier démarrage (affichés quand le process manager est arrêté) */
  services: z.optional(z.array(z.string())),
});
export type ProjectDevenv = z.output<typeof ProjectDevenv>;

/** Question annexe d'une session (#153) : fork caché, et l'instant du fork (contexte en retard). */
export const AsideRef = z.object({
  id: z.string(),
  /** création du fork (ms) */
  at: z.number(),
});
export type AsideRef = z.output<typeof AsideRef>;

export const SettingsData = z.object({
  /** questions annexes : session -> son fork caché */
  asides: z.prefault(z.record(z.string(), AsideRef), {}),
  /** process managers devenv : chemin du projet -> éléments devenv de la barre */
  devenvs: z.prefault(z.record(z.string(), z.array(ProjectDevenv)), {}),
  /** liens épinglés : chemin du projet -> liens */
  links: z.prefault(z.record(z.string(), z.array(ProjectLink)), {}),
  /** disposition de la barre de chaque projet : terminaux et liens mélangés, dossiers (#145) */
  layout: z.prefault(z.record(z.string(), z.array(LayoutEntry)), {}),
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
  /** ordre des sous-projets (glisser-déposer) : chemin du projet parent -> chemins des sous-projets */
  subprojects: z.prefault(z.record(z.string(), z.array(z.string())), {}),
  /** mode de la barre latérale */
  sidebarMode: z.prefault(SidebarMode, 'all'),
  /** sessions ouvertes (onglets de la barre latérale), dans l'ordre d'ouverture */
  openSessions: z.prefault(z.array(z.string()), []),
  /** sessions non lues : l'agent a fini de répondre, session pas encore ouverte */
  unread: z.prefault(z.array(z.string()), []),
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
  /** fenêtre git : fichiers modifiés en arborescence de dossiers (sinon à plat) */
  gitFilesTree: z.prefault(z.boolean(), false),
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
  /** dictée et lecture à voix haute */
  voice: z.prefault(VoiceSettings, DEFAULT_VOICE),
  /** modèle par défaut des sessions sans modèle (`fournisseur/modèle`) ; absent = automatique */
  defaultModel: z.optional(z.string()),
  /** niveau de raisonnement par défaut associé au modèle par défaut */
  defaultVariant: z.optional(z.string()),
});
export type SettingsData = z.output<typeof SettingsData>;
export type Theme = SettingsData['appTheme'];

const DEFAULTS: SettingsData = { asides: {}, links: {}, layout: {}, devenvs: {}, browsers: {}, ides: {}, markdown: DEFAULT_MARKDOWN_STYLE, voice: DEFAULT_VOICE, terminals: {}, favorites: [], subprojects: {}, sidebarMode: 'all', openSessions: [], unread: [], collapsed: [], sidebarWidth: 0, showTools: true, gitFilesTree: false, notifications: true, notificationSound: true, fontScale: 100, maxWidth: 860, terminalIntegrated: true, terminalPanelHeight: 300, appTheme: 'system', terminalTheme: 'system' };

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

/** `item` déplacé juste avant `before` (à la fin si null ou absent) ; liste inchangée si `item` est absent. */
export function moveBefore(list: readonly string[], item: string, before: string | null): string[] {
  if (!list.includes(item) || item === before) return [...list];
  const rest = list.filter((x) => x !== item);
  const at = before === null ? -1 : rest.indexOf(before);
  return at < 0 ? [...rest, item] : [...rest.slice(0, at), item, ...rest.slice(at)];
}

/** Disposition complète du projet dans `d` (terminaux et liens actuels). */
export const layoutOf = (d: SettingsData, project: string): LayoutEntry[] => normalizeLayout(d.layout[project], d.terminals[project] ?? [], d.links[project] ?? [], d.devenvs[project] ?? []);

/** `d` avec la disposition du projet modifiée par `fn` (puis normalisée). */
function withLayout(d: SettingsData, project: string, fn: (layout: LayoutEntry[]) => LayoutEntry[]): SettingsData {
  const next = normalizeLayout(fn(layoutOf(d, project)), d.terminals[project] ?? [], d.links[project] ?? [], d.devenvs[project] ?? []);
  return { ...d, layout: { ...d.layout, [project]: next } };
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

  /**
   * Modifie les réglages sous verrou (l'app et la CLI `ocg` écrivent le même fichier) : le fichier
   * est relu juste avant, pour ne pas écraser une modification d'un autre processus.
   */
  update(fn: (d: SettingsData) => SettingsData): void {
    try {
      withLock(this.#path, () => {
        const onDisk = read(this.#path);
        const base = onDisk ?? this.data.peek();
        const next = fn(base);
        this.#set(next);
        this.#written = JSON.stringify(next);
        GLib.mkdir_with_parents(GLib.path_get_dirname(this.#path), 0o700);
        GLib.file_set_contents(this.#path, encoder.encode(`${JSON.stringify(next, null, 2)}\n`));
        // peut contenir une clé API (voix) : lisible par l'utilisateur seul
        GLib.chmod(this.#path, 0o600);
      });
    } catch (e) {
      console.error(`réglages non enregistrés : ${String(e)}`);
    }
  }

  isFavorite(path: string): boolean {
    return this.data.peek().favorites.includes(path);
  }

  /** Déplace un favori avant `before` (à la fin si null) : ordre de la barre latérale en mode Favoris. */
  moveFavorite(path: string, before: string | null): void {
    this.update((d) => ({ ...d, favorites: moveBefore(d.favorites, path, before) }));
  }

  /** Déplace une session ouverte avant `before` (à la fin si null). */
  moveOpenSession(id: string, before: string | null): void {
    this.update((d) => ({ ...d, openSessions: moveBefore(d.openSessions, id, before) }));
  }

  /**
   * Ajoute ou retire un favori. Ajout : `descendants` (ses sous-projets du moment) sont ajoutés
   * avec lui ; retrait : lui seul (chaque sous-projet se retire séparément).
   */
  toggleFavorite(path: string, descendants: readonly string[] = []): void {
    this.update((d) => {
      if (d.favorites.includes(path)) return { ...d, favorites: d.favorites.filter((p) => p !== path) };
      const added = [path, ...descendants].filter((p, i, all) => !d.favorites.includes(p) && all.indexOf(p) === i);
      return { ...d, favorites: [...d.favorites, ...added] };
    });
  }

  /** Ordre des sous-projets de `parent` : `item` placé avant `before` (à la fin si null), parmi `siblings`. */
  moveSubproject(parent: string, siblings: readonly string[], item: string, before: string | null): void {
    this.update((d) => ({ ...d, subprojects: { ...d.subprojects, [parent]: moveChild(siblings, item, before) } }));
  }

  /** Modifie un réglage optionnel (`undefined` = valeur automatique, retirée du fichier). */
  setOptional(key: 'terminal' | 'terminalCommand' | 'defaultModel' | 'defaultVariant' | 'defaultIde', value: string | undefined): void {
    if (this.data.peek()[key] === value) return;
    this.update((d) => {
      const { [key]: _old, ...rest } = d;
      return value === undefined ? rest : { ...rest, [key]: value };
    });
  }

  /**
   * Ajoute ou remplace (même id) un lien du projet ; `folder` : rangé dans ce dossier (null : au
   * premier niveau), absent : place inchangée (à la fin pour un nouveau lien).
   */
  saveLink(project: string, link: ProjectLink, folder?: string | null): void {
    this.update((d) => {
      const list = d.links[project] ?? [];
      const next = list.some((l) => l.id === link.id) ? list.map((l) => (l.id === link.id ? link : l)) : [...list, link];
      const saved = { ...d, links: { ...d.links, [project]: next } };
      return folder === undefined ? saved : withLayout(saved, project, (l) => moveEntry(l, `link:${link.id}`, folder, null));
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

  /** Modifie les réglages de la voix (`openaiKey: undefined` : clé retirée). */
  setVoice(patch: Partial<VoiceSettings>): void {
    this.update((d) => {
      const { openaiKey, ...merged } = { ...d.voice, ...patch };
      return { ...d, voice: openaiKey === undefined || openaiKey === '' ? merged : { ...merged, openaiKey } };
    });
  }

  setMarkdownStyle(patch: Partial<MarkdownStyle>): void {
    this.update((d) => ({ ...d, markdown: { ...d.markdown, ...patch } }));
  }

  setNumber(key: 'fontScale' | 'maxWidth' | 'sidebarWidth' | 'terminalPanelHeight', value: number): void {
    if (this.data.peek()[key] !== value) this.update((d) => ({ ...d, [key]: value }));
  }

  /** Ajoute une session aux sessions ouvertes (à la fin), si elle n'y est pas. */
  /** Marque une session non lue (true) ou lue (false). */
  setUnread(id: string, unread: boolean): void {
    if (this.data.peek().unread.includes(id) === unread) return;
    this.update((d) => ({ ...d, unread: unread ? [...d.unread, id] : d.unread.filter((x) => x !== id) }));
  }

  /** Question annexe de la session `parent` ; null : retirée. */
  setAside(parent: string, aside: AsideRef | null): void {
    const current = this.data.peek().asides[parent];
    if (current?.id === aside?.id && current?.at === aside?.at) return;
    this.update((d) => {
      const { [parent]: _old, ...rest } = d.asides;
      return { ...d, asides: aside === null ? rest : { ...rest, [parent]: aside } };
    });
  }

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

  setGitFilesTree(tree: boolean): void {
    if (this.data.peek().gitFilesTree !== tree) this.update((d) => ({ ...d, gitFilesTree: tree }));
  }

  setShowTools(show: boolean): void {
    if (this.data.peek().showTools !== show) this.update((d) => ({ ...d, showTools: show }));
  }

  /** Ajoute ou remplace (même id) un terminal du projet ; `folder` : comme pour saveLink. */
  saveTerminal(project: string, terminal: ProjectTerminal, folder?: string | null): void {
    this.update((d) => {
      const list = d.terminals[project] ?? [];
      const next = list.some((t) => t.id === terminal.id) ? list.map((t) => (t.id === terminal.id ? terminal : t)) : [...list, terminal];
      const saved = { ...d, terminals: { ...d.terminals, [project]: next } };
      return folder === undefined ? saved : withLayout(saved, project, (l) => moveEntry(l, `terminal:${terminal.id}`, folder, null));
    });
  }

  /** Ajoute ou remplace (même id) un élément devenv du projet ; `folder` : comme pour saveLink. */
  saveDevenv(project: string, devenv: ProjectDevenv, folder?: string | null): void {
    this.update((d) => {
      const list = d.devenvs[project] ?? [];
      const next = list.some((x) => x.id === devenv.id) ? list.map((x) => (x.id === devenv.id ? devenv : x)) : [...list, devenv];
      const saved = { ...d, devenvs: { ...d.devenvs, [project]: next } };
      return folder === undefined ? saved : withLayout(saved, project, (l) => moveEntry(l, `devenv:${devenv.id}`, folder, null));
    });
  }

  /** Services connus d'un élément devenv (cache, liste réelle quand il tourne). */
  setDevenvServices(project: string, id: string, services: readonly string[]): void {
    const withServices = (x: ProjectDevenv): ProjectDevenv => {
      if (x.id !== id) return x;
      const next: ProjectDevenv = { id: x.id, name: x.name, services: [...services] };
      if (x.cwd !== undefined) next.cwd = x.cwd;
      return next;
    };
    this.update((d) => ({ ...d, devenvs: { ...d.devenvs, [project]: (d.devenvs[project] ?? []).map((x) => withServices(x)) } }));
  }

  removeDevenv(project: string, id: string): void {
    this.update((d) => {
      const { [project]: list = [], ...others } = d.devenvs;
      const next = list.filter((x) => x.id !== id);
      return { ...d, devenvs: next.length === 0 ? others : { ...others, [project]: next } };
    });
  }

  /** Modifie la disposition de la barre du projet (complétée avec les terminaux et liens actuels). */
  updateLayout(project: string, fn: (layout: LayoutEntry[]) => LayoutEntry[]): void {
    this.update((d) => withLayout(d, project, fn));
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
