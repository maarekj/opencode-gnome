// `ocg link` : liens web épinglés d'un projet (barre « Liens » de l'application).
import { DirenvError, expandVariables, withScheme } from '../shared/direnv.ts';
import { Settings, type ProjectLink } from '../shared/settings.ts';
import { parseArgs, UsageError } from './args.ts';
import { folderName, folderOption } from './folders.ts';
import { projectDir } from './project.ts';

export const LINK_HELP = `ocg link — liens web épinglés d'un projet

Raccourcis vers les pages utiles d'un projet (application locale, admin, documentation…),
affichés dans la barre « Liens » de l'application. L'adresse peut contenir des variables
($PORT_WEB, \${HOST}…) lues dans le direnv du projet (.envrc) au moment de l'ouverture : le
même lien marche dans chaque worktree, avec ses propres ports.

Usage :
  ocg link list [--project DIR] [--all] [--json]   liens et adresses résolues
  ocg link add --url ADRESSE [--name NOM] [--folder DOSSIER] [--project DIR]
  ocg link edit <lien> [--url ADRESSE] [--name NOM] [--folder DOSSIER] [--project DIR]
  ocg link rm <lien> [--project DIR]
  ocg link resolve <lien | ADRESSE> [--project DIR]  adresse finale (variables remplacées)

Options :
  --project DIR   projet (défaut : racine git du dossier courant, sinon le dossier courant)
  --url ADRESSE   ex. localhost:$PORT_WEB/admin (http:// ajouté si besoin)
  --name NOM      défaut : déduit de l'adresse
  --folder NOM    range le lien dans ce dossier de la barre (créé s'il n'existe pas) ;
                  '' : le sort de son dossier (voir ocg folder help)

<lien> : identifiant ou nom.

Exemples :
  ocg link add --name Admin --url 'localhost:$PORT_WEB/admin'
  ocg link add --url https://docs.example.com
  ocg link resolve Admin`;

const FLAGS = new Set(['all']);

const nameFromUrl = (url: string): string => url.replace(/^[a-z]+:\/\//iu, '').replace(/\/$/u, '').slice(0, 30) || 'Lien';

function find(settings: Settings, project: string, ref: string | undefined): ProjectLink {
  if (ref === undefined) throw new UsageError('lien manquant (identifiant ou nom)');
  const list = settings.data.peek().links[project] ?? [];
  const l = list.find((x) => x.id === ref) ?? list.find((x) => x.name === ref);
  if (l === undefined) throw new Error(`lien inconnu dans ${project} : ${ref} (ocg link list)`);
  return l;
}

/** Adresse finale, ou l'erreur de résolution (variable inconnue, .envrc non autorisé). */
async function resolve(url: string, dir: string): Promise<{ url: string } | { error: string }> {
  try {
    return { url: withScheme(await expandVariables(url.trim(), dir)) };
  } catch (e) {
    return { error: e instanceof DirenvError || e instanceof Error ? e.message : String(e) };
  }
}

export async function linkCommand(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest, FLAGS);
  if (command === undefined || command === 'help' || args.flags.has('help')) {
    print(LINK_HELP);
    return 0;
  }
  const settings = new Settings();
  const project = projectDir(args.options.get('project'));
  const json = args.flags.has('json');
  const ref = args.positional[0];
  switch (command) {
    case 'list': {
      const all = settings.data.peek().links;
      const entries = args.flags.has('all') ? Object.entries(all) : [[project, all[project] ?? []] as const];
      // `url` : adresse saisie ; `resolved` : variables remplacées (ou `error`)
      const rows = await Promise.all(
        entries.flatMap(([p, list]) =>
          list.map(async (l) => {
            const r = await resolve(l.url, p);
            return { ...l, project: p, folder: folderName(settings, p, `link:${l.id}`), ...('url' in r ? { resolved: r.url } : r) };
          }),
        ),
      );
      if (json) print(JSON.stringify(rows, null, 2));
      else if (rows.length === 0) print(`Aucun lien dans ${project}. Ajoute-en un : ocg link add --name Admin --url 'localhost:$PORT/admin'`);
      else for (const r of rows) print(`${r.id}  ${r.name}${r.folder === null ? '' : `  📁 ${r.folder}`}\n    ${r.url}${'resolved' in r ? (r.resolved === withScheme(r.url) ? '' : `  →  ${r.resolved}`) : `  (⚠ ${r.error})`}`);
      return 0;
    }
    case 'add': {
      const url = args.options.get('url')?.trim();
      if (url === undefined || url === '') throw new UsageError('--url est requis');
      const taken = new Set((settings.data.peek().links[project] ?? []).map((l) => l.id));
      let id = `l${Date.now().toString(36)}`;
      while (taken.has(id)) id += 'x';
      const name = args.options.get('name')?.trim();
      const link: ProjectLink = { id, name: name === undefined || name === '' ? nameFromUrl(url) : name, url };
      settings.saveLink(project, link, folderOption(settings, project, args.options.get('folder')));
      const r = await resolve(url, project);
      if (json) print(JSON.stringify({ ...link, project, ...('url' in r ? { resolved: r.url } : r) }, null, 2));
      else print(`Lien « ${link.name} » ajouté (${id}) → ${'url' in r ? r.url : `⚠ ${r.error}`}`);
      return 0;
    }
    case 'edit': {
      const l = find(settings, project, ref);
      const next: ProjectLink = { ...l };
      const name = args.options.get('name');
      if (name !== undefined) next.name = name.trim() === '' ? nameFromUrl(next.url) : name.trim();
      const url = args.options.get('url');
      if (url !== undefined) next.url = url.trim();
      settings.saveLink(project, next, folderOption(settings, project, args.options.get('folder')));
      print(`Lien « ${next.name} » modifié`);
      return 0;
    }
    case 'rm': {
      const l = find(settings, project, ref);
      settings.removeLink(project, l.id);
      print(`Lien « ${l.name} » supprimé`);
      return 0;
    }
    case 'resolve': {
      if (ref === undefined) throw new UsageError('lien ou adresse manquant');
      const known = (settings.data.peek().links[project] ?? []).find((x) => x.id === ref || x.name === ref);
      const r = await resolve(known?.url ?? ref, project);
      if ('error' in r) throw new Error(r.error);
      print(r.url);
      return 0;
    }
    default:
      throw new UsageError(`commande inconnue : link ${command} (ocg link help)`);
  }
}
