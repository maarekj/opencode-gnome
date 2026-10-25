// Non-régression #99 : journal des runs compacté au-delà de 2 Mo ; runs-seen corrompu → échecs signalés.
import GLib from 'gi://GLib';
import { loadRuns, recordRun, runsPath, unseenFailures, type RunRecord } from '../src/shared/tasks.ts';

const dir = GLib.dir_make_tmp('ogt-runs-XXXXXX');
GLib.setenv('XDG_DATA_HOME', dir, true);
GLib.setenv('OGT_NAMESPACE', 'test', true);
const run = (i: number): RunRecord => ({ run: `r${i}`, task: 't', trigger: 'schedule', status: i % 2 === 0 ? 'success' : 'error', start: i, end: i + 1, summary: 'x'.repeat(400) });
GLib.mkdir_with_parents(GLib.path_get_dirname(runsPath()), 0o700);
GLib.file_set_contents(runsPath(), new TextEncoder().encode(Array.from({ length: 6000 }, (_, i) => `${JSON.stringify(run(i))}\n`).join('')));
recordRun(run(6000));
const runs = loadRuns();
GLib.file_set_contents(GLib.build_filenamev([dir, 'opencode-gnome', 'runs-seen-test']), new TextEncoder().encode('corrompu'));
const unseen = unseenFailures(runs);
const ok = runs.length === 1000 && runs[0]?.run === 'r6000' && unseen.length > 0;
print(ok ? 'TEST OK' : `journal incorrect : ${runs.length} runs, premier ${runs[0]?.run}, ${unseen.length} échecs non vus`);
