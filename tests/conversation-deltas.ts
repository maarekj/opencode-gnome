// Non-régression #72 : deltas reçus pendant le chargement de l'historique d'une session en cours
// de génération : ni perdus, ni dupliqués, et l'instantané (plus ancien) ne fait pas reculer le texte.
import GLib from 'gi://GLib';
import { Conversation } from '../src/shared/conversation.ts';
import type { MessageWithParts, SessionEvent } from '../src/shared/schemas.ts';
import type { Store } from '../src/shared/store.ts';

let emit: (e: SessionEvent) => void = () => {};
let resolvePage: (v: { messages: MessageWithParts[]; older: string | null }) => void = () => {};
const fake = {
  client: {
    messagePage: () =>
      new Promise((r) => {
        resolvePage = r;
      }),
    permissions: () => Promise.resolve([]),
    questions: () => Promise.resolve([]),
    todos: () => Promise.resolve([]),
  },
  onSessionEvents: (_id: string, fn: (e: SessionEvent) => void) => {
    emit = fn;
    return () => {};
  },
  onReconnect: () => () => {},
  session: () => ({ directory: '/tmp' }),
  children: { peek: () => new Map() },
};
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- store factice
const conv = new Conversation(fake as unknown as Store, 'ses');
const delta = (partID: string, d: string): SessionEvent =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- événement minimal
  ({ type: 'message.part.delta', properties: { sessionID: 'ses', messageID: 'm2', partID, field: 'text', delta: d } }) as unknown as SessionEvent;
const page = (a: string, b: string): MessageWithParts[] =>
  [
    { info: { id: 'm1', role: 'user', sessionID: 'ses', time: { created: 1 } }, parts: [{ id: 'p0', messageID: 'm1', sessionID: 'ses', type: 'text', text: 'question' }] },
    { info: { id: 'm2', role: 'assistant', sessionID: 'ses', time: { created: 2 } }, parts: [
      { id: 'p1', messageID: 'm2', sessionID: 'ses', type: 'text', text: a },
      { id: 'p2', messageID: 'm2', sessionID: 'ses', type: 'text', text: b },
    ] },
  ];

const loop = new GLib.MainLoop(null, false);
const run = async (): Promise<void> => {
  const started = conv.start();
  // p1 inconnue : deltas « Bon », « jour », « ! » ; l'instantané a été pris après « jour »
  emit(delta('p1', 'Bon'));
  emit(delta('p1', 'jour'));
  emit(delta('p1', ' !'));
  resolvePage({ messages: page('Bonjour', 'texte'), older: null });
  await started;
  emit(delta('p1', ' Suite'));
  await new Promise((r) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
      r(null);
      return GLib.SOURCE_REMOVE;
    });
  });
  const texts = conv.blocks.peek().map((b) => b.part.peek()['text']);
  print(texts.includes('Bonjour ! Suite') ? 'TEST OK' : `texte incorrect : ${JSON.stringify(texts)}`);
};
void run().finally(() => loop.quit());
loop.run();
