// Conversation sur le modèle OpenCode 2 (#171) : historique réel d'un serveur v2.2.7, puis flux
// réel enregistré (un prompt, quatre lectures, une réponse), dont une partie reçue pendant le
// chargement : rien de perdu ni de dupliqué, l'instantané (plus ancien) ne fait pas reculer le texte.
import GLib from 'gi://GLib';
import { Conversation, type Item } from '../src/shared/conversation.ts';
import type { SessionEventV2, Store } from '../src/shared/store.ts';
import events from '../specs/fixtures/v2/events.json' with { type: 'json' };
import history from '../specs/fixtures/v2/messages.json' with { type: 'json' };

let emit: (e: SessionEventV2) => void = () => {};
let resolvePage: (v: { items: unknown[]; next: string | null }) => void = () => {};
const fake = {
  client: {
    v2: {
      messages: () =>
        new Promise((r) => {
          resolvePage = r;
        }),
    },
    permissions: () => Promise.resolve([]),
    questions: () => Promise.resolve([]),
  },
  onSessionEventsV2: (_id: string, fn: (e: SessionEventV2) => void) => {
    emit = fn;
    return () => {};
  },
  onReconnect: () => () => {},
  session: () => ({ directory: '/tmp/opencode/v2/proj' }),
  children: { peek: () => new Map() },
};
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- store factice
const conv = new Conversation(fake as unknown as Store, 'ses_e308d346affePqocFV8uajeZ4x');
const all = (events as { type: string; created?: number; data?: unknown }[]).map((e): SessionEventV2 => ({ type: e.type, created: e.created ?? 0, data: e.data }));
const wait = (ms: number): Promise<void> =>
  new Promise((r) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      r();
      return GLib.SOURCE_REMOVE;
    });
  });
const failures: string[] = [];
const check = (ok: boolean, what: string): void => {
  if (!ok) failures.push(what);
};

const loop = new GLib.MainLoop(null, false);
const run = async (): Promise<void> => {
  const started = conv.start();
  await wait(10);
  // première moitié du flux pendant le chargement, puis l'historique, puis la fin du flux
  const half = all.findIndex((e) => e.type === 'session.text.delta');
  for (const e of all.slice(0, half + 1)) emit(e);
  resolvePage({ items: (history as { data: unknown[] }).data, next: null });
  await started;
  for (const e of all.slice(half + 1)) emit(e);
  await wait(200);
  const items: Item[] = conv.blocks.peek().map((b) => b.item.peek());
  const texts = items.flatMap((i) => (i.kind === 'text' ? [i.text] : []));
  check(texts.some((t) => t.includes('20 mots') || t.includes('hello')), `réponse absente : ${JSON.stringify(texts)}`);
  check(new Set(texts).size === texts.length, `texte dupliqué : ${JSON.stringify(texts)}`);
  const tools = items.flatMap((i) => (i.kind === 'tool' ? [i.tool] : []));
  check(tools.length >= 4 && tools.every((t) => t.status === 'completed' && t.name === 'read'), `outils : ${JSON.stringify(tools.map((t) => [t.name, t.status]))}`);
  check(tools.some((t) => t.output.includes('1: hello')), 'sortie de read absente');
  const users = items.filter((i) => i.kind === 'user');
  check(users.length === new Set(users.map((u) => u.id)).size && users.some((u) => u.kind === 'user' && u.text.includes('20 mots')), 'message utilisateur absent ou dupliqué');
  const turns = conv.blocks.peek().filter((b) => b.kind === 'turn');
  check(turns.length > 0 && turns.every((t) => t.turn?.peek().completed !== undefined), 'tours non terminés');
  check(conv.context.peek()?.modelID === 'iceman-free', 'contexte absent');
  print(failures.length === 0 ? 'TEST OK' : failures.join('\n'));
};
void run().finally(() => loop.quit());
loop.run();
