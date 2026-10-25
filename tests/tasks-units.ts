// Non-régression #71 : nom de tâche multi-ligne ou avec `%` sans injection dans les unités.
import { serviceUnit, timerUnit, type ScheduledTask } from '../src/shared/tasks.ts';

const task: ScheduledTask = {
  id: 't',
  name: 'nom\nExecStartPre=/bin/false %h',
  directory: '/tmp',
  prompt: 'p',
  schedule: 'daily',
  timeout: 30,
  permissions: 'all',
  session: { mode: 'new' },
  enabled: true,
  created: 1,
};
const units = `${serviceUnit(task, '/bin/ocg %test')}\n${timerUnit(task)}`;
const injected = units.split('\n').some((l) => l.startsWith('ExecStartPre'));
print(!injected && units.includes('%%h') && units.includes('"/bin/ocg %%test"') ? 'TEST OK' : `unité incorrecte :\n${units}`);
