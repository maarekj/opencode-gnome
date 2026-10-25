// Non-régression #70 : une copie ancienne d'une tâche « session réutilisée » enregistrée après
// le premier run ne perd pas la session créée par le run.
import GLib from 'gi://GLib';
import { loadTasks, patchTask, saveTask, type ScheduledTask } from '../src/shared/tasks.ts';

const dir = GLib.dir_make_tmp('ocg-test-XXXXXX');
GLib.setenv('XDG_CONFIG_HOME', dir, true);
GLib.setenv('OCG_UNIT_DIR', `${dir}/units`, true);
GLib.setenv('OCG_NAMESPACE', 'test', true);
const task: ScheduledTask = {
  id: 't',
  name: 't',
  directory: '/tmp',
  prompt: 'p',
  schedule: 'daily',
  timeout: 30,
  permissions: 'all',
  session: { mode: 'reuse' },
  enabled: false,
  created: 1,
};
const loop = new GLib.MainLoop(null, false);
const run = async (): Promise<void> => {
  await saveTask(task).catch(() => {}); // unités : systemctl absent en test, sans importance
  patchTask('t', { session: { mode: 'reuse', id: 'ses_run' } }); // premier run
  await saveTask({ ...task, name: 'renommée' }).catch(() => {}); // éditeur ouvert avant le run
  const t = loadTasks()[0];
  print(t?.session.id === 'ses_run' && t.name === 'renommée' ? 'TEST OK' : `session perdue : ${JSON.stringify(t)}`);
};
void run().finally(() => loop.quit());
loop.run();
