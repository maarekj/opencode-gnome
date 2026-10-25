// Non-régression #98 : une partie reçue avant son message (message provisoire « assistant ») prend
// le type de bloc du vrai message (utilisateur) quand il arrive.
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
const ev = (e: unknown): SessionEvent =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- événement minimal
  e as SessionEvent;
const loop = new GLib.MainLoop(null, false);
const run = async (): Promise<void> => {
  const started = conv.start();
  resolvePage({ messages: [], older: null });
  await started;
  emit(ev({ type: 'message.part.updated', properties: { sessionID: 'ses', part: { id: 'u1', messageID: 'mu', sessionID: 'ses', type: 'text', text: 'ma question' } } }));
  // rafraîchissement entre les deux (le message arrive plus tard)
  await new Promise((r) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
      r(null);
      return GLib.SOURCE_REMOVE;
    });
  });
  emit(ev({ type: 'message.updated', properties: { sessionID: 'ses', info: { id: 'mu', role: 'user', sessionID: 'ses', time: { created: 5 } } } }));
  await new Promise((r) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
      r(null);
      return GLib.SOURCE_REMOVE;
    });
  });
  const b = conv.blocks.peek().find((x) => x.id === 'u1');
  print(b?.kind === 'user' && b.created === 5 ? 'TEST OK' : `bloc incorrect : ${JSON.stringify({ kind: b?.kind, created: b?.created })}`);
};
void run().finally(() => loop.quit());
loop.run();
