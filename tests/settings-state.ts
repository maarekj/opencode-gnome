// #156 : état d'interface dans state.json (migration depuis settings.json), écritures différées et
// regroupées de l'application, sans écraser les changements de la CLI.
import GLib from 'gi://GLib';
import { Settings } from '../src/shared/settings.ts';

const dir = GLib.dir_make_tmp('og-settings-XXXXXX');
const path = `${dir}/settings.json`;
const state = `${dir}/state.json`;
const json = (p: string): Record<string, unknown> => {
  const [, bytes] = GLib.file_get_contents(p);
  const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return typeof raw === 'object' && raw !== null ? Object.fromEntries(Object.entries(raw)) : {};
};
const errors: string[] = [];
const check = (ok: boolean, what: string): void => {
  if (!ok) errors.push(what);
};

// réglages d'avant #156 : tout dans settings.json
GLib.file_set_contents(path, JSON.stringify({ favorites: ['/a'], openSessions: ['ses_1'], unread: ['ses_1'] }));

const app = new Settings(path, { deferred: true });
check(app.data.peek().openSessions[0] === 'ses_1', 'migration : sessions ouvertes lues dans settings.json');
const before = new TextDecoder().decode(GLib.file_get_contents(path)[1]);
app.openSession('ses_2');
app.setUnreadMany(new Map([['ses_1', false], ['ses_2', true]]));
check(app.data.peek().openSessions.join() === 'ses_1,ses_2', 'état en mémoire immédiat');
check(new TextDecoder().decode(GLib.file_get_contents(path)[1]) === before && !GLib.file_test(state, GLib.FileTest.EXISTS), 'rien écrit avant le délai');

// la CLI modifie un réglage partagé entre-temps
const cli = new Settings(path);
cli.update((d) => ({ ...d, favorites: [...d.favorites, '/b'] }));
check(GLib.file_test(state, GLib.FileTest.EXISTS) && JSON.stringify(json(state)['openSessions']).includes('ses_1'), 'CLI : state.json créé depuis les anciens réglages');

app.toggleFavorite('/c');
app.flush();
const shared = json(path);
const st = json(state);
// modification de l'app rejouée sur le fichier relu : celle de la CLI est gardée
check(JSON.stringify(shared['favorites']) === JSON.stringify(['/a', '/b', '/c']), `favoris : ${JSON.stringify(shared['favorites'])}`);
check(app.data.peek().favorites.join() === '/a,/b,/c', 'mémoire mise à jour avec le changement de la CLI');
check(!('openSessions' in shared) && !('unread' in shared), 'état d’interface retiré de settings.json');
check(JSON.stringify(st['openSessions']) === '["ses_1","ses_2"]' && JSON.stringify(st['unread']) === '["ses_2"]', `state.json : ${JSON.stringify(st)}`);

// relecture : les deux fichiers fusionnés
const again = new Settings(path);
check(again.data.peek().openSessions.join() === 'ses_1,ses_2' && again.data.peek().favorites.includes('/c'), 'relecture des deux fichiers');

// settings.json illisible au moment d'enregistrer : réglages en mémoire gardés, pas remis à zéro
GLib.file_set_contents(path, '{ tronqué');
app.toggleFavorite('/d');
app.flush();
check(JSON.stringify(json(path)['favorites']) === '["/a","/b","/c","/d"]', `fichier illisible : ${JSON.stringify(json(path)['favorites'])}`);

print(errors.length === 0 ? 'TEST OK' : errors.join('\n'));
