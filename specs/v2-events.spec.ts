// Événements OpenCode 2 (#170) : flux réel d'un serveur v2.2.7 (un prompt, quatre lectures de
// fichier, une réponse), relu par nos schémas.
import * as z from 'zod/mini';
import * as E from '../src/shared/v2/events.ts';
import raw from './fixtures/v2/events.json' with { type: 'json' };

const events = (raw as unknown[]).map((j) => z.parse(E.Envelope, j));
const of = <S extends z.ZodMiniType>(type: string, s: S): z.output<S>[] => events.filter((e) => e.type === type).map((e) => z.parse(s, e.data));

describe('événements v2', () => {
  it('toutes les enveloppes sont lisibles', () => {
    expect(events.length).toBe(48);
    expect(events[0]?.type).toBe('server.connected');
  });

  it('étapes, blocs et outils', () => {
    expect(of('session.step.started', E.StepStarted).map((s) => s.model.id)).toEqual(['iceman-free', 'iceman-free']);
    expect(of('session.step.ended', E.StepEnded).map((s) => s.finish)).toEqual(['tool-calls', 'stop']);
    const deltas = of('session.text.delta', E.BlockDelta).map((d) => d.delta).join('');
    expect(of('session.text.ended', E.BlockEnded)[0]?.text).toBe(deltas);
    expect(of('session.tool.called', E.ToolCalled)[0]?.input).toEqual({ path: 'a.txt' });
    const out = of('session.tool.success', E.ToolSuccess)[0]?.content[0];
    expect(out?.type === 'text' ? out.text : '').toContain('1: hello');
  });

  it('file d’attente et exécution', () => {
    const q = of('session.inbox.enqueued', E.InboxEnqueued)[0];
    expect(z.parse(E.UserPayload, q?.item.payload).text).toContain('Lis a.txt');
    expect(events.filter((e) => e.type.startsWith('session.execution.')).map((e) => e.type)).toEqual(['session.execution.started', 'session.execution.succeeded']);
  });
});
