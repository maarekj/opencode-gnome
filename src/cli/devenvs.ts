// `ocg devenv` : éléments devenv de la barre d'un projet (process manager de `devenv up`, #147).
import { devenvAction, devenvDir, devenvStatus, phaseLabel } from '../shared/devenv.ts';
import { Settings, type ProjectDevenv } from '../shared/settings.ts';
import { parseArgs, UsageError } from './args.ts';
import { folderName, folderOption } from './folders.ts';
import { projectDir } from './project.ts';

export const DEVENV_HELP = `ocg devenv — services devenv d'un projet

Un élément devenv de la barre du projet affiche les services lancés par « devenv up » dans un
dossier (process manager de devenv) : état, démarrer, arrêter, redémarrer, logs.

Usage :
  ocg devenv list [--project DIR] [--json]          éléments devenv et état de leurs services
  ocg devenv add [--name NOM] [--cwd DOSSIER] [--folder DOSSIER] [--project DIR]
  ocg devenv edit <devenv> [--name NOM] [--cwd DOSSIER] [--folder DOSSIER] [--project DIR]
  ocg devenv rm <devenv> [--project DIR]           (les services ne sont pas arrêtés)
  ocg devenv up | down <devenv> [--project DIR]     tout démarrer (devenv up --detach) / tout arrêter

Options :
  --name NOM      défaut : devenv
  --cwd DOSSIER   dossier contenant devenv.nix, relatif au projet (défaut : racine du projet)
  --folder NOM    range l'élément dans ce dossier de la barre (créé s'il n'existe pas) ; '' : le sort

<devenv> : identifiant ou nom.

Exemple :
  ocg devenv add --name "wt1: services" --cwd worktrees/projet-1 --folder "worktree 1"`;

function find(settings: Settings, project: string, ref: string | undefined): ProjectDevenv {
  if (ref === undefined) throw new UsageError('devenv manquant (identifiant ou nom)');
  const list = settings.data.peek().devenvs[project] ?? [];
  const d = list.find((x) => x.id === ref) ?? list.find((x) => x.name === ref);
  if (d === undefined) throw new Error(`devenv inconnu dans ${project} : ${ref} (ocg devenv list)`);
  return d;
}

export async function devenvCommand(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest, new Set());
  if (command === undefined || command === 'help' || args.flags.has('help')) {
    print(DEVENV_HELP);
    return 0;
  }
  const settings = new Settings();
  const project = projectDir(args.options.get('project'));
  const ref = args.positional[0];
  switch (command) {
    case 'list': {
      const rows = await Promise.all(
        (settings.data.peek().devenvs[project] ?? []).map(async (d) => {
          const state = await devenvStatus(devenvDir(d, project));
          return { id: d.id, name: d.name, cwd: d.cwd, dir: devenvDir(d, project), folder: folderName(settings, project, `devenv:${d.id}`), state };
        }),
      );
      if (args.flags.has('json')) print(JSON.stringify(rows, null, 2));
      else if (rows.length === 0) print(`Aucun devenv dans ${project}. Ajoute-en un : ocg devenv add --cwd .`);
      else
        for (const r of rows) {
          const s = r.state;
          print(`${r.id}  ${r.name}${r.folder === null ? '' : `  📁 ${r.folder}`}  ·  ${r.dir}`);
          if (s.kind === 'stopped') print('    ○ process manager arrêté');
          else if (s.kind === 'error') print(`    ⚠ ${s.message}`);
          else for (const p of s.processes) print(`    ${p.name}  ${phaseLabel(p.phase)}${p.restarts > 0 ? ` (${p.restarts} redémarrages)` : ''}`);
        }
      return 0;
    }
    case 'add': {
      const taken = new Set((settings.data.peek().devenvs[project] ?? []).map((x) => x.id));
      let id = `d${Date.now().toString(36)}`;
      while (taken.has(id)) id += 'x';
      const cwd = args.options.get('cwd')?.trim();
      const named = args.options.get('name')?.trim() ?? '';
      const d: ProjectDevenv = { id, name: named === '' ? 'devenv' : named, ...(cwd === undefined || cwd === '' || cwd === '.' ? {} : { cwd }) };
      settings.saveDevenv(project, d, folderOption(settings, project, args.options.get('folder')));
      print(`devenv « ${d.name} » ajouté (${id}) · ${devenvDir(d, project)}`);
      return 0;
    }
    case 'edit': {
      const d = find(settings, project, ref);
      const next: ProjectDevenv = { ...d };
      const name = args.options.get('name');
      if (name !== undefined && name.trim() !== '') next.name = name.trim();
      const cwd = args.options.get('cwd');
      if (cwd !== undefined) {
        if (cwd.trim() === '' || cwd.trim() === '.') delete next.cwd;
        else next.cwd = cwd.trim();
      }
      settings.saveDevenv(project, next, folderOption(settings, project, args.options.get('folder')));
      print(`devenv « ${next.name} » modifié`);
      return 0;
    }
    case 'rm': {
      const d = find(settings, project, ref);
      settings.removeDevenv(project, d.id);
      print(`devenv « ${d.name} » retiré`);
      return 0;
    }
    case 'up':
    case 'down': {
      const d = find(settings, project, ref);
      await devenvAction(devenvDir(d, project), command);
      print(`devenv « ${d.name} » : ${command === 'up' ? 'services démarrés' : 'services arrêtés'}`);
      return 0;
    }
    default:
      throw new UsageError(`commande inconnue : devenv ${command} (ocg devenv help)`);
  }
}
