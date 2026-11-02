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
  /** layout zellij (#155) : bare, compact, default ou layout personnel ; absent = préférence globale */
  layout: z.optional(z.string()),
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
  /** layout zellij des terminaux persistants (#155) : bare (sans barre), compact, default ou layout personnel */
  zellijLayout: z.prefault(z.string(), 'bare'),
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

const DEFAULTS: SettingsData = { asides: {}, links: {}, layout: {}, devenvs: {}, browsers: {}, ides: {}, markdown: DEFAULT_MARKDOWN_STYLE, voice: DEFAULT_VOICE, terminals: {}, favorites: [], subprojects: {}, sidebarMode: 'all', openSessions: [], unread: [], collapsed: [], sidebarWidth: 0, showTools: true, gitFilesTree: false, notifications: true, notificationSound: true, fontScale: 100, maxWidth: 860, terminalIntegrated: true, zellijLayout: 'bare', terminalPanelHeight: 300, appTheme: 'system', terminalTheme: 'system' };

export const settingsPath = (): string => GLib.build_filenamev([GLib.get_user_config_dir(), 'opencode-gnome', 'settings.json']);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Écrit un fichier de réglages : lisible par l'utilisateur seul (peut contenir une clé API, voix). */
function write(path: string, text: string): void {
  GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
  GLib.file_set_contents(path, encoder.encode(text));
  GLib.chmod(path, 0o600);
}

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

/**
 * État d'interface (#156) : propre à l'application, changé souvent (session ouverte, lu / non lu,
 * repli…), enregistré dans state.json à côté de settings.json, sans verrou (ocg ne s'en sert pas).
 */
export const STATE_KEYS = ['openSessions', 'unread', 'collapsed', 'asides', 'sidebarWidth', 'terminalPanelHeight', 'sidebarMode'] as const satisfies readonly (keyof SettingsData)[];
const isStateKey = (k: string): boolean => (STATE_KEYS as readonly string[]).includes(k);

export const statePath = (settings: string): string => GLib.build_filenamev([GLib.path_get_dirname(settings), 'state.json']);

/** Texte du fichier ; `undefined` s'il est absent. */
function readText(path: string): string | undefined {
  try {
    const [ok, bytes] = GLib.file_get_contents(path);
    return ok ? decoder.decode(bytes) : undefined;
  } catch {
    return undefined; // absent
  }
}

/** Objet JSON du fichier ; `undefined` s'il est absent, `null` s'il est illisible (JSON invalide…). */
function readJson(path: string, text = readText(path)): Record<string, unknown> | null | undefined {
  if (text === undefined) return undefined;
  try {
    const raw: unknown = JSON.parse(text);
    const parsed = z.safeParse(z.record(z.string(), z.unknown()), raw);
    if (!parsed.success) console.error(`réglages illisibles (objet attendu), ignorés : ${path}`);
    return parsed.success ? parsed.data : null;
  } catch {
    console.error(`réglages illisibles, ignorés : ${path}`);
    return null;
  }
}

/** Champs `keys` de `d`. */
const pick = (d: SettingsData, keys: Iterable<string>): Record<string, unknown> => Object.fromEntries([...keys].map((k) => [k, (d as Record<string, unknown>)[k]]));

/** Réglages partagés (sans l'état d'interface), tels qu'enregistrés dans settings.json. */
const sharedOf = (d: SettingsData): Record<string, unknown> => Object.fromEntries(Object.entries(d).filter(([k]) => !isStateKey(k)));

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

/** Délai d'enregistrement des réglages en mode différé (application) : changements regroupés. */
const SAVE_DELAY_MS = 400;

export class Settings {
  readonly data: Accessor<SettingsData>;
  readonly #set: (v: SettingsData) => void;
  readonly #path: string;
  readonly #statePath: string;
  /** application : écritures différées et regroupées ; CLI : immédiates (le processus s'arrête aussitôt) */
  readonly #deferred: boolean;
  #monitor: Gio.FileMonitor | null = null;
  /** texte de settings.json écrit par ce processus (ignoré par le moniteur) */
  #written = '';
  /** modifications des réglages partagés pas encore enregistrées : rejouées sur le fichier relu */
  #pending: ((d: SettingsData) => SettingsData)[] = [];
  /** réglages partagés connus sur disque (dernier chargement / enregistrement) : base de rejeu si le fichier est illisible */
  #saved: Record<string, unknown> = {};
  #stateDirty = false;
  #timer = 0;

  constructor(path = settingsPath(), opts: { deferred?: boolean } = {}) {
    this.#path = path;
    this.#statePath = statePath(path);
    this.#deferred = opts.deferred === true;
    const [data, set] = createState<SettingsData>(this.#load());
    this.data = data;
    this.#set = set;
  }

  /** settings.json, puis l'état d'interface de state.json (absent : celui de settings.json, migration). */
  #load(): SettingsData {
    const shared = readJson(this.#path) ?? {};
    const state = readJson(this.#statePath) ?? {};
    const d = parseSettings({ ...shared, ...state });
    this.#saved = sharedOf(d);
    return d;
  }

  /** Recharge les réglages partagés quand un autre processus (ocg) modifie settings.json. */
  watch(): void {
    if (this.#monitor !== null) return;
    this.#monitor = Gio.File.new_for_path(this.#path).monitor_file(Gio.FileMonitorFlags.NONE, null);
    this.#monitor.connect('changed', (_m: Gio.FileMonitor, _f: Gio.File, _o: Gio.File | null, event: Gio.FileMonitorEvent) => {
      if (event !== Gio.FileMonitorEvent.CHANGES_DONE_HINT && event !== Gio.FileMonitorEvent.CREATED) return;
      const text = readText(this.#path);
      // notre propre écriture : rien à relire
      if (text === undefined || text === this.#written) return;
      // illisible (écriture en cours d'un autre processus…) : état courant conservé
      const disk = readJson(this.#path, text);
      if (disk === null || disk === undefined) return;
      const current = this.data.peek();
      // l'état d'interface est le nôtre ; les changements locaux pas encore enregistrés sont rejoués
      this.#saved = disk;
      const next = this.#replay(disk);
      if (JSON.stringify(sharedOf(next)) !== JSON.stringify(sharedOf(current))) this.#set(next);
    });
  }

  /**
   * Modifie les réglages. Application : état en mémoire immédiat, enregistrement regroupé un peu
   * plus tard (#156). CLI : fichier relu sous verrou juste avant (l'application et `ocg` écrivent
   * le même fichier), écrit aussitôt.
   */
  update(fn: (d: SettingsData) => SettingsData): void {
    try {
      if (!this.#deferred) {
        withLock(this.#path, () => {
          // fichier illisible : dernier état connu (jamais remplacé par les valeurs par défaut)
          const base = parseSettings({ ...(readJson(this.#path) ?? this.#saved), ...pick(this.data.peek(), STATE_KEYS) });
          const next = fn(base);
          this.#set(next);
          this.#writeShared(next);
          if (STATE_KEYS.some((k) => next[k] !== base[k])) this.#writeState(next);
        });
        return;
      }
      const prev = this.data.peek();
      const next = fn(prev);
      const changed = Object.keys(next).filter((k) => (next as Record<string, unknown>)[k] !== (prev as Record<string, unknown>)[k]);
      if (changed.length === 0) return;
      if (changed.some((k) => isStateKey(k))) this.#stateDirty = true;
      if (changed.some((k) => !isStateKey(k))) this.#pending.push(fn);
      this.#set(next);
      this.#schedule(SAVE_DELAY_MS);
    } catch (e) {
      console.error(`réglages non enregistrés : ${String(e)}`);
    }
  }

  #schedule(ms: number): void {
    if (this.#timer !== 0) return;
    this.#timer = GLib.timeout_add(GLib.PRIORITY_LOW, ms, () => {
      this.#timer = 0;
      this.flush(false);
      return GLib.SOURCE_REMOVE;
    });
  }

  /**
   * Enregistre les changements en attente. `wait` : attend le verrou (fermeture de l'application) ;
   * sinon, verrou pris par un autre processus : nouvel essai un peu plus tard, sans bloquer.
   */
  flush(wait = true): void {
    if (this.#timer !== 0) {
      GLib.source_remove(this.#timer);
      this.#timer = 0;
    }
    try {
      if (this.#stateDirty) {
        this.#writeState(this.data.peek());
        this.#stateDirty = false;
      }
      if (this.#pending.length === 0) return;
      const done = withLock(
        this.#path,
        () => {
          // fichier relu : les modifications d'ici sont rejouées dessus (celles d'ocg sont gardées)
          // illisible ou absent : dernier état connu du disque (pas de réglages remis à zéro)
          const next = this.#replay(readJson(this.#path) ?? this.#saved);
          this.#pending = [];
          this.#writeShared(next, this.data.peek());
          if (JSON.stringify(sharedOf(next)) !== JSON.stringify(sharedOf(this.data.peek()))) this.#set(next);
        },
        wait ? 2000 : 0,
      );
      if (!done) this.#schedule(100);
    } catch (e) {
      console.error(`réglages non enregistrés : ${String(e)}`);
    }
  }

  /** Réglages partagés `disk`, état d'interface en mémoire, modifications en attente rejouées. */
  #replay(disk: Record<string, unknown>): SettingsData {
    const base = parseSettings({ ...disk, ...pick(this.data.peek(), STATE_KEYS) });
    const next = this.#pending.reduce((d, fn) => fn(d), base);
    // état d'interface : celui de la mémoire (les modifications rejouées ne le changent pas)
    return { ...next, ...pick(this.data.peek(), STATE_KEYS) };
  }

  /**
   * settings.json sans l'état d'interface ; state.json absent (réglages d'avant #156) : écrit
   * d'abord depuis `state`, pour ne pas perdre les sessions ouvertes et autres.
   */
  #writeShared(d: SettingsData, state: SettingsData = d): void {
    if (!GLib.file_test(this.#statePath, GLib.FileTest.EXISTS)) this.#writeState(state);
    this.#saved = sharedOf(d);
    this.#written = `${JSON.stringify(this.#saved, null, 2)}\n`;
    write(this.#path, this.#written);
  }

  #writeState(d: SettingsData): void {
    write(this.#statePath, `${JSON.stringify(pick(d, STATE_KEYS), null, 2)}\n`);
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

  /** Layout zellij par défaut des terminaux persistants (#155). */
  setZellijLayout(layout: string): void {
    if (this.data.peek().zellijLayout !== layout) this.update((d) => ({ ...d, zellijLayout: layout }));
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
  /** Plusieurs sessions lues / non lues en une seule modification. */
  setUnreadMany(changes: ReadonlyMap<string, boolean>): void {
    const current = this.data.peek().unread;
    const next = [...current.filter((id) => changes.get(id) !== false), ...[...changes].filter(([id, u]) => u && !current.includes(id)).map(([id]) => id)];
    if (next.length !== current.length || next.some((id, i) => id !== current[i])) this.update((d) => ({ ...d, unread: next }));
  }

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
