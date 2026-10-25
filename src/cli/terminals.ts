// `ocg terminal` : terminaux persistants d'un projet (sessions zellij), les mêmes que la barre
// « Terminaux » de l'application (réglages partagés, affichés en direct par l'app).
import { Settings, type ProjectTerminal } from '../shared/settings.ts';
import { TerminalManager, cwdOf, terminalId, zellijInstalled } from '../shared/terminals.ts';
import { parseArgs, UsageError } from './args.ts';
import { projectDir } from './project.ts';

export const TERMINAL_HELP = `ocg terminal — terminaux persistants d'un projet

Un terminal persistant lance une commande (serveur de dev, watcher, devenv up…) dans une session
zellij en arrière-plan : elle continue de tourner sans fenêtre, et l'application l'affiche dans la
barre « Terminaux » du projet (ouvrir, redémarrer, arrêter).

Usage :
  ocg terminal list [--project DIR] [--all] [--json]   terminaux du projet (--all : tous les projets) et leur état
  ocg terminal add --name NOM [--command CMD] [--cwd SOUS-DOSSIER] [--start] [--project DIR]
  ocg terminal edit <terminal> [--name NOM] [--command CMD] [--cwd SOUS-DOSSIER] [--project DIR]
  ocg terminal rm <terminal> [--project DIR]         (arrête la session si elle tourne)
  ocg terminal start | stop | restart <terminal> [--project DIR]

Options :
  --project DIR   projet (défaut : racine git du dossier courant, sinon le dossier courant)
  --command CMD   commande lancée par le shell de l'utilisateur ; vide : simple shell
  --cwd DIR       répertoire de lancement, relatif au projet (défaut : racine du projet)
  --start         démarre le terminal juste après l'avoir ajouté

<terminal> : identifiant (og-projet-nom) ou nom.

Exemples :
  ocg terminal add --name web --command "pnpm dev" --start
  ocg terminal add --name api --command "cargo watch -x run" --cwd services/api
  ocg terminal list --json
  ocg terminal restart web`;

const FLAGS = new Set(['start', 'all']);

function find(settings: Settings, project: string, ref: string | undefined): ProjectTerminal {
  if (ref === undefined) throw new UsageError('terminal manquant (identifiant ou nom)');
  const list = settings.data.peek().terminals[project] ?? [];
  const t = list.find((x) => x.id === ref) ?? list.find((x) => x.name === ref);
  if (t === undefined) throw new Error(`terminal inconnu dans ${project} : ${ref} (ocg terminal list)`);
  return t;
}

const describe = (t: ProjectTerminal, project: string, running: boolean): Record<string, unknown> => ({ ...t, project, cwd: cwdOf(t, project), running });

export async function terminalCommand(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest, FLAGS);
  if (command === undefined || command === 'help' || args.flags.has('help')) {
    print(TERMINAL_HELP);
    return 0;
  }
  const settings = new Settings();
  const manager = new TerminalManager(() => ({}));
  await manager.refresh();
  const project = projectDir(args.options.get('project'));
  const json = args.flags.has('json');
  const ref = args.positional[0];
  switch (command) {
    case 'list': {
      const all = settings.data.peek().terminals;
      const entries = args.flags.has('all') ? Object.entries(all) : [[project, all[project] ?? []] as const];
      const rows = entries.flatMap(([p, list]) => list.map((t) => describe(t, p, manager.isRunning(t.id))));
      if (json) print(JSON.stringify(rows, null, 2));
      else if (rows.length === 0) print(`Aucun terminal dans ${project}. Ajoute-en un : ocg terminal add --name web --command "pnpm dev"`);
      else for (const r of rows) print(`${String(r['id'])}  ${String(r['name'])}  ${r['running'] === true ? '● en cours' : '○ arrêté'}\n    ${String(r['command']) === '' ? '(shell)' : String(r['command'])}  ·  ${String(r['cwd'])}`);
      return 0;
    }
    case 'add': {
      const name = args.options.get('name')?.trim();
      if (name === undefined || name === '') throw new UsageError('--name est requis');
      const taken = Object.values(settings.data.peek().terminals).flat().map((t) => t.id);
      const cwd = args.options.get('cwd')?.trim();
      const t: ProjectTerminal = { id: terminalId(project, name, taken), name, command: args.options.get('command')?.trim() ?? '', ...(cwd === undefined || cwd === '' ? {} : { cwd }) };
      settings.saveTerminal(project, t);
      if (args.flags.has('start')) await manager.start(t, project);
      if (json) print(JSON.stringify(describe(t, project, manager.isRunning(t.id)), null, 2));
      else print(`Terminal « ${t.name} » ajouté (${t.id})${args.flags.has('start') ? ', démarré' : ` : ocg terminal start ${t.id}`}`);
      return 0;
    }
    case 'edit': {
      const t = find(settings, project, ref);
      const next: ProjectTerminal = { ...t };
      const name = args.options.get('name');
      if (name !== undefined) next.name = name.trim();
      const cmd = args.options.get('command');
      if (cmd !== undefined) next.command = cmd.trim();
      const cwd = args.options.get('cwd');
      if (cwd !== undefined) {
        if (cwd.trim() === '') delete next.cwd;
        else next.cwd = cwd.trim();
      }
      settings.saveTerminal(project, next);
      print(`Terminal « ${next.name} » modifié${manager.isRunning(t.id) ? ' (redémarre-le pour appliquer : ocg terminal restart ' + t.id + ')' : ''}`);
      return 0;
    }
    case 'rm': {
      const t = find(settings, project, ref);
      if (manager.isRunning(t.id)) await manager.stop(t);
      settings.removeTerminal(project, t.id);
      print(`Terminal « ${t.name} » supprimé`);
      return 0;
    }
    case 'start':
    case 'stop':
    case 'restart': {
      if (!zellijInstalled()) throw new Error('zellij introuvable');
      const t = find(settings, project, ref);
      if (command === 'start') await manager.ensure(t, project);
      else if (command === 'stop') await manager.stop(t);
      else await manager.restart(t, project);
      print(`Terminal « ${t.name} » ${command === 'stop' ? 'arrêté' : command === 'start' ? 'démarré' : 'redémarré'}`);
      return 0;
    }
    default:
      throw new UsageError(`commande inconnue : terminal ${command} (ocg terminal help)`);
  }
}
