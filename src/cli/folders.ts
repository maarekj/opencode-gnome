// `ocg folder` : dossiers de la barre d'un projet (terminaux et liens rangés ensemble, #145).
import { addFolder, findFolder, folderId, folderOf, removeFolder, renameFolder, type FolderEntry } from '../shared/layout.ts';
import { layoutOf, Settings } from '../shared/settings.ts';
import { parseArgs, UsageError } from './args.ts';
import { projectDir } from './project.ts';

export const FOLDER_HELP = `ocg folder — dossiers de la barre d'un projet

Dans l'application, terminaux, liens et devenv d'un projet partagent une même barre ; un dossier y
regroupe des terminaux, des liens et des devenv (ex. un dossier par worktree, « utilitaires »), affiché comme
une pastille qui ouvre un menu.

Usage :
  ocg folder list [--project DIR] [--json]       dossiers et leur contenu
  ocg folder add NOM [--project DIR]
  ocg folder rename <dossier> NOM [--project DIR]
  ocg folder rm <dossier> [--project DIR]        (son contenu reste dans la barre)

Ranger un terminal, un lien ou un devenv : option --folder de « ocg terminal add|edit »,
« ocg link add|edit » et « ocg devenv add|edit » (dossier créé s'il n'existe pas ; --folder '' : sortir du dossier).

<dossier> : identifiant ou nom.

Exemples :
  ocg folder add "worktree 1"
  ocg terminal add --name "wt1: pnpm dev" --command "pnpm dev" --cwd ../wt1 --folder "worktree 1"
  ocg link add --name "wt1" --url 'localhost:$PORT_WEB' --folder "worktree 1"`;

/**
 * Dossier demandé par `--folder` : undefined si l'option est absente, null pour '' (premier
 * niveau), sinon l'identifiant du dossier (créé s'il n'existe pas).
 */
export function folderOption(settings: Settings, project: string, value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const name = value.trim();
  if (name === '') return null;
  const known = findFolder(layoutOf(settings.data.peek(), project), name);
  if (known !== undefined) return known.folder;
  let id = '';
  settings.updateLayout(project, (l) => {
    id = folderId(l);
    return addFolder(l, id, name);
  });
  return id;
}

/** Nom du dossier de l'élément `key` (null : premier niveau). */
export function folderName(settings: Settings, project: string, key: string): string | null {
  const layout = layoutOf(settings.data.peek(), project);
  const id = folderOf(layout, key);
  return id === null ? null : (findFolder(layout, id)?.name ?? null);
}

function find(settings: Settings, project: string, ref: string | undefined): FolderEntry {
  if (ref === undefined) throw new UsageError('dossier manquant (identifiant ou nom)');
  const f = findFolder(layoutOf(settings.data.peek(), project), ref);
  if (f === undefined) throw new Error(`dossier inconnu dans ${project} : ${ref} (ocg folder list)`);
  return f;
}

export function folderCommand(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  const args = parseArgs(rest, new Set());
  if (command === undefined || command === 'help' || args.flags.has('help')) {
    print(FOLDER_HELP);
    return 0;
  }
  const settings = new Settings();
  const project = projectDir(args.options.get('project'));
  const [ref, name] = args.positional;
  switch (command) {
    case 'list': {
      const d = settings.data.peek();
      const terminals = new Map((d.terminals[project] ?? []).map((t) => [t.id, t.name]));
      const links = new Map((d.links[project] ?? []).map((l) => [l.id, l.name]));
      const devenvs = new Map((d.devenvs[project] ?? []).map((x) => [x.id, x.name]));
      const folders = layoutOf(d, project).filter((e): e is FolderEntry => 'folder' in e);
      const rows = folders.map((f) => ({
        id: f.folder,
        name: f.name,
        items: f.items.map((r) =>
          'terminal' in r ? { terminal: r.terminal, name: terminals.get(r.terminal) ?? '' } : 'devenv' in r ? { devenv: r.devenv, name: devenvs.get(r.devenv) ?? '' } : { link: r.link, name: links.get(r.link) ?? '' },
        ),
      }));
      if (args.flags.has('json')) print(JSON.stringify(rows, null, 2));
      else if (rows.length === 0) print(`Aucun dossier dans ${project}. Crée-en un : ocg folder add "worktree 1"`);
      else for (const r of rows) print(`${r.id}  ${r.name}\n${r.items.map((i) => `    ${'terminal' in i ? '▸ terminal' : 'devenv' in i ? '⚙ devenv' : '↗ lien'}  ${i.name}`).join('\n') || '    (vide)'}`);
      return 0;
    }
    case 'add': {
      if (ref === undefined || ref.trim() === '') throw new UsageError('nom du dossier manquant');
      if (findFolder(layoutOf(settings.data.peek(), project), ref.trim()) !== undefined) throw new Error(`le dossier « ${ref.trim()} » existe déjà`);
      const id = folderOption(settings, project, ref) ?? '';
      print(`Dossier « ${ref.trim()} » ajouté (${id})`);
      return 0;
    }
    case 'rename': {
      const f = find(settings, project, ref);
      if (name === undefined || name.trim() === '') throw new UsageError('nouveau nom manquant');
      settings.updateLayout(project, (l) => renameFolder(l, f.folder, name.trim()));
      print(`Dossier « ${f.name} » renommé en « ${name.trim()} »`);
      return 0;
    }
    case 'rm': {
      const f = find(settings, project, ref);
      settings.updateLayout(project, (l) => removeFolder(l, f.folder));
      print(`Dossier « ${f.name} » supprimé (${f.items.length} élément${f.items.length > 1 ? 's' : ''} remis dans la barre)`);
      return 0;
    }
    default:
      throw new UsageError(`commande inconnue : folder ${command} (ocg folder help)`);
  }
}
