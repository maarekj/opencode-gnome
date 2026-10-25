// Ouverture d'un projet dans un IDE (VS Code, JetBrains, Zed…) : applications installées détectées
// par leurs fichiers .desktop, IDE choisi projet par projet (sinon celui des préférences).
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { onCleanup, type Accessor } from 'gnim';
import { errorMessage } from '../shared/errors.ts';
import type { Settings } from '../shared/settings.ts';
import { shq } from '../shared/terminal.ts';

export interface Ide {
  /** identifiant du fichier .desktop (ex. code.desktop) */
  readonly id: string;
  readonly name: string;
  readonly icon: Gio.Icon | null;
  readonly app: Gio.AppInfo;
}

const IDE_CATEGORIES = new Set(['IDE', 'TextEditor']);

/** Catégories du fichier .desktop (non exposées par Gio.AppInfo) ; applications de terminal exclues (vim…). */
function categoriesOf(info: Gio.AppInfo): string[] {
  const id = info.get_id();
  if (id === null) return [];
  try {
    const kf = new GLib.KeyFile();
    kf.load_from_data_dirs(`applications/${id}`, GLib.KeyFileFlags.NONE);
    const terminal = (() => {
      try {
        return kf.get_boolean('Desktop Entry', 'Terminal');
      } catch {
        return false;
      }
    })();
    return terminal ? [] : kf.get_string('Desktop Entry', 'Categories').split(';');
  } catch {
    return [];
  }
}

/** Ordre du choix automatique : IDE de développement courants d'abord, éditeurs simples en dernier. */
const PREFERRED = [/^code/u, /codium/u, /zed/u, /jetbrains|idea|webstorm|phpstorm|pycharm|goland|rider|clion/u, /builder/u];
const rank = (ide: Ide): number => {
  const i = PREFERRED.findIndex((re) => re.test(ide.id.toLowerCase()));
  return i < 0 ? PREFERRED.length : i;
};

let idesCache: Ide[] | null = null;
let monitor: Gio.AppInfoMonitor | null = null;

/** IDE et éditeurs installés (liste en cache, invalidée quand des applications sont (dés)installées). */
export function installedIdes(): Ide[] {
  if (monitor === null) {
    monitor = Gio.AppInfoMonitor.get();
    monitor.connect('changed', () => {
      idesCache = null;
    });
  }
  idesCache ??= scanIdes();
  return idesCache;
}

/** IDE et éditeurs installés qui ouvrent un dossier (hors gestionnaires d'URL, applications masquées). */
function scanIdes(): Ide[] {
  const out: Ide[] = [];
  for (const info of Gio.AppInfo.get_all()) {
    if (!info.should_show()) continue;
    if (!categoriesOf(info).some((c) => IDE_CATEGORIES.has(c))) continue;
    const exec = info.get_commandline() ?? '';
    // il faut un paramètre fichier / URI ; les gestionnaires d'URL (vscode://…) sont exclus
    if (!/%[fFuU]/u.test(exec) || exec.includes('--open-url')) continue;
    const id = info.get_id();
    if (id === null) continue;
    out.push({ id, name: info.get_display_name() ?? info.get_name() ?? id, icon: info.get_icon(), app: info });
  }
  return out.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** IDE retenu en mode automatique. */
export function automaticIde(ides: readonly Ide[]): Ide | null {
  return ides.toSorted((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** IDE du projet : réglage du projet, sinon préférence globale, sinon le premier détecté. */
export function ideFor(settings: Settings, project: string, ides: readonly Ide[] = installedIdes()): Ide | null {
  const { ides: perProject, defaultIde } = settings.data.peek();
  for (const id of [perProject[project], defaultIde]) {
    const found = id === undefined ? undefined : ides.find((i) => i.id === id);
    if (found !== undefined) return found;
  }
  return automaticIde(ides);
}

/**
 * Lance l'IDE sur le dossier. La ligne de commande du .desktop est reprise avec le chemin à la
 * place du paramètre (%f, %u…) : les IDE à paramètre URI (JetBrains) reçoivent ainsi un chemin.
 */
export function openInIde(ide: Ide, directory: string): void {
  if (!GLib.file_test(directory, GLib.FileTest.IS_DIR)) throw new Error(`dossier introuvable : ${directory}`);
  if (GLib.getenv('OPENCODE_GNOME_TEST_LINKS') !== null) {
    console.log(`IDE ${ide.id} ${directory}`);
    return;
  }
  const exec = (ide.app.get_commandline() ?? '')
    .replaceAll(/%[fFuU]/gu, shq(directory))
    .replaceAll(/%[ick]/gu, '')
    .replaceAll('%%', '%');
  const [, argv] = GLib.shell_parse_argv(exec);
  if (argv === null || argv.length === 0) throw new Error(`commande vide pour ${ide.name}`);
  GLib.spawn_async(directory, argv, ideEnv(argv[0] ?? ''), GLib.SpawnFlags.SEARCH_PATH, null);
}

/**
 * NixOS : les IDE installés par JetBrains Toolbox sont des binaires non-nix qui passent par nix-ld,
 * dont les bibliothèques par défaut n'ont pas tout (libXi…). Toolbox les lance depuis son
 * environnement FHS ; lancés directement (sans instance déjà ouverte), ils échouent. On ajoute
 * les bibliothèques de cet environnement FHS à NIX_LD_LIBRARY_PATH.
 */
function ideEnv(program: string): string[] | null {
  const nixLd = GLib.getenv('NIX_LD');
  if (nixLd === null || program.startsWith('/nix/store/')) return null;
  const rootfs = toolboxRootfs();
  if (rootfs === null) return null;
  const libs = [`${rootfs}/usr/lib64`, `${rootfs}/usr/lib`, GLib.getenv('NIX_LD_LIBRARY_PATH') ?? ''].filter((p) => p !== '').join(':');
  return GLib.environ_setenv(GLib.get_environ(), 'NIX_LD_LIBRARY_PATH', libs, true);
}

let rootfsCache: string | null | undefined;
/** Racine de l'environnement FHS de JetBrains Toolbox (nixpkgs), lue dans son lanceur. */
function toolboxRootfs(): string | null {
  if (rootfsCache !== undefined) return rootfsCache;
  rootfsCache = null;
  const bin = GLib.find_program_in_path('jetbrains-toolbox');
  if (bin === null) return null;
  try {
    // le lanceur (lien vers /nix/store/…-bwrap) contient le chemin de la racine FHS
    const [ok, bytes] = GLib.file_get_contents(bin);
    if (!ok) return null;
    const m = /\/nix\/store\/[a-z0-9]+-jetbrains-toolbox-[^/"' \0]*-fhsenv-rootfs/u.exec(new TextDecoder('latin1').decode(bytes));
    rootfsCache = m?.[0] ?? null;
  } catch {
    rootfsCache = null;
  }
  return rootfsCache;
}

const menuItem = (label: string, action: string, target: string): Gio.MenuItem => {
  const item = Gio.MenuItem.new(label, null);
  item.set_action_and_target_value(action, GLib.Variant.new_string(target));
  return item;
};

/**
 * Bouton d'en-tête « ouvrir dans l'IDE » : clic = IDE du projet ; flèche = autres IDE et choix de
 * l'IDE du projet. Masqué si aucun IDE n'est installé ou sans projet.
 */
export function IdeButton({
  project,
  settings,
  toast,
  directory,
}: {
  /** projet (clé du réglage d'IDE) */
  project: Accessor<string | null>;
  settings: Settings;
  toast: (m: string) => void;
  /** dossier à ouvrir s'il diffère du projet (session dans un worktree) */
  directory?: () => string | null;
}): Gtk.Widget {
  const ides = installedIdes();
  const button = new Adw.SplitButton({ valign: Gtk.Align.CENTER, visible: ides.length > 0 });
  const open = (ide: Ide | null): void => {
    const dir = directory?.() ?? project.peek();
    if (ide === null || dir === null) return;
    try {
      openInIde(ide, dir);
    } catch (e) {
      toast(`Ouverture dans ${ide.name} impossible : ${errorMessage(e)}`);
    }
  };
  button.connect('clicked', () => {
    const dir = project.peek();
    if (dir !== null) open(ideFor(settings, dir, ides));
  });

  const group = new Gio.SimpleActionGroup();
  button.insert_action_group('ide', group);
  const openWith = new Gio.SimpleAction({ name: 'open', parameterType: new GLib.VariantType('s') });
  openWith.connect('activate', (_a: Gio.SimpleAction, p: GLib.Variant | null) => open(ides.find((i) => i.id === p?.get_string()[0]) ?? null));
  group.add_action(openWith);
  const choose = new Gio.SimpleAction({ name: 'choose', parameterType: new GLib.VariantType('s') });
  choose.connect('activate', (_a: Gio.SimpleAction, p: GLib.Variant | null) => {
    const dir = project.peek();
    const id = p?.get_string()[0];
    if (dir === null || id === undefined) return;
    settings.setProjectIde(dir, id === '' ? undefined : id);
  });
  group.add_action(choose);

  const update = (): void => {
    const dir = project.peek();
    const current = dir === null ? null : ideFor(settings, dir, ides);
    const own = dir === null ? undefined : settings.data.peek().ides[dir];
    button.visible = ides.length > 0 && dir !== null;
    // icône de l'IDE (nom en infobulle) : l'en-tête reste compact
    button.child = current?.icon === null || current === null ? new Gtk.Image({ iconName: 'text-editor-symbolic' }) : new Gtk.Image({ gicon: current.icon, pixelSize: 16 });
    button.tooltipText = current === null ? '' : `Ouvrir le projet dans ${current.name}`;
    const menu = new Gio.Menu();
    const others = new Gio.Menu();
    for (const ide of ides) if (ide.id !== current?.id) others.append_item(menuItem(`Ouvrir dans ${ide.name}`, 'ide.open', ide.id));
    if (others.get_n_items() > 0) menu.append_section(null, others);
    const pick = new Gio.Menu();
    for (const ide of ides) pick.append_item(menuItem(`${ide.id === own ? '✓ ' : ''}${ide.name}`, 'ide.choose', ide.id));
    pick.append_item(menuItem(`${own === undefined ? '✓ ' : ''}Par défaut (préférences)`, 'ide.choose', ''));
    menu.append_section('IDE de ce projet', pick);
    button.menuModel = menu;
  };
  update();
  onCleanup(project.subscribe(update));
  let last = '';
  onCleanup(
    settings.data.subscribe(() => {
      const { ides: own, defaultIde } = settings.data.peek();
      const key = JSON.stringify([own, defaultIde]);
      if (key !== last) {
        last = key;
        update();
      }
    }),
  );
  return button;
}
