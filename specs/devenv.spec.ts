// Process manager devenv (#147) : lecture de `devenv processes list`, messages, résumé.
import { cleanMessage, parseProcessList, phaseKind, refreshedServices, summary } from '../src/shared/devenv.ts';

const p = (phase: string): { name: string; phase: string; restarts: number } => ({ name: phase, phase, restarts: 0 });

describe('devenv', () => {
  it('lit la liste des services', () => {
    const out = 'failing                        gave_up restarts: 5\nticker                         ready restarts: 0\nweb                            starting restarts: 1\n';
    expect(parseProcessList(out)).toEqual([
      { name: 'failing', phase: 'gave_up', restarts: 5 },
      { name: 'ticker', phase: 'ready', restarts: 0 },
      { name: 'web', phase: 'starting', restarts: 1 },
    ]);
  });

  it('nettoie les messages (couleurs, puces)', () => {
    expect(cleanMessage('  \u001B[31m×\u001B[0m No process manager is running. Start processes first with `devenv up -d`\n\n')).toBe('No process manager is running. Start processes first with `devenv up -d`');
  });

  it('cache des services : mis à jour seulement si la liste réelle change', () => {
    const run = { kind: 'running' as const, processes: [p('postgres'), p('web')] };
    expect(refreshedServices(undefined, run)).toEqual(['postgres', 'web']);
    expect(refreshedServices(['postgres', 'web'], run)).toBeNull();
    expect(refreshedServices(['postgres', 'old'], run)).toEqual(['postgres', 'web']);
    expect(refreshedServices(['postgres'], { kind: 'stopped' })).toBeNull();
  });

  it('résume l’état', () => {
    expect(summary({ kind: 'stopped' })).toEqual({ text: 'arrêté', kind: 'stopped' });
    expect(summary({ kind: 'running', processes: [p('ready'), p('ready')] })).toEqual({ text: '2/2', kind: 'ok' });
    expect(summary({ kind: 'running', processes: [p('ready'), p('starting')] })).toEqual({ text: '1/2', kind: 'busy' });
    expect(summary({ kind: 'running', processes: [p('ready'), p('gave_up')] })).toEqual({ text: '1 en échec', kind: 'failed' });
    expect(summary({ kind: 'running', processes: [p('ready'), p('not_started')] })).toEqual({ text: '1/2', kind: 'ok' });
    expect(phaseKind('stopped')).toBe('stopped');
  });
});
