// ocg : CLI d'opencode-gnome — terminaux persistants, liens épinglés, tâches planifiées.
// Même configuration que l'application, qui affiche les changements en direct.
import GLib from 'gi://GLib';
import system from 'system';
import { errorMessage } from '../shared/errors.ts';
import { UsageError } from './args.ts';
import { LINK_HELP, linkCommand } from './links.ts';
import { notify } from './notify.ts';
import { TASK_HELP, taskCommand } from './tasks.ts';
import { TERMINAL_HELP, terminalCommand } from './terminals.ts';

const HELP = `ocg — opencode-gnome en ligne de commande

Configure ce que l'application opencode-gnome affiche pour chaque projet ; les changements
apparaissent aussitôt dans l'application (si elle est ouverte). Pensé pour être utilisé par les
agents opencode comme par l'utilisateur.

Usage :
  ocg terminal …   terminaux persistants d'un projet (serveurs de dev, watchers ; sessions zellij)
  ocg link …       liens web épinglés d'un projet (variables direnv : $PORT_WEB…)
  ocg task …       tâches planifiées (prompts envoyés à heures régulières ou à la main)
  ocg help [terminal | link | task | all]

Options communes : --project DIR (défaut : projet du dossier courant), --json, -h / --help.

Exemples :
  ocg terminal add --name web --command "pnpm dev" --start
  ocg link add --name Admin --url 'localhost:$PORT_WEB/admin'
  ocg task add --name "Revue" --dir . --at "Mon..Fri 09:00" --prompt "Résume les commits d'hier."

Aide détaillée : ocg <commande> --help (ou ocg help all).`;

function main(argv: readonly string[]): Promise<number> | number {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case '-h':
    case '--help':
      print(HELP);
      return 0;
    case 'help': {
      const topic = rest[0];
      const all = [HELP, TERMINAL_HELP, LINK_HELP, TASK_HELP];
      const by: Record<string, string> = { terminal: TERMINAL_HELP, link: LINK_HELP, task: TASK_HELP, all: all.join(`\n\n${'─'.repeat(72)}\n\n`) };
      print(topic === undefined ? HELP : (by[topic] ?? HELP));
      return 0;
    }
    case 'terminal':
    case 'terminals':
      return terminalCommand(rest);
    case 'link':
    case 'links':
      return linkCommand(rest);
    case 'task':
    case 'tasks':
      return taskCommand(rest);
    default:
      throw new UsageError(`commande inconnue : ${command} (ocg help)`);
  }
}

// boucle principale explicite : les appels asynchrones (libsoup, sous-processus) en ont besoin
const loop = new GLib.MainLoop(null, false);
let code = 0;
const run = async (): Promise<void> => {
  try {
    code = await main(system.programArgs);
  } catch (e) {
    printerr(`ocg : ${errorMessage(e)}`);
    code = 2;
    // run planifié (systemd) qui échoue avant de démarrer (tasks.json illisible…) : sans
    // notification, l'échec ne serait visible que dans le journal systemd (#100)
    const [command, sub, id] = system.programArgs;
    if (command === 'task' && (sub === 'exec' || sub === 'finalize')) {
      notify({ id: `ocg-error-${id ?? ''}`, title: 'Tâche planifiée impossible à lancer', body: errorMessage(e), urgent: true });
    }
  }
  loop.quit();
};
void run();
loop.run();
system.exit(code);
