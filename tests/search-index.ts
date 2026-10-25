// Recherche dans les conversations (#126) : index construit par l'API, recherche sans accents
// ni casse (tous les termes), titres, filtres projet et période, extrait.
import GLib from 'gi://GLib';
import type { OpencodeClient } from '../src/shared/client.ts';
import { SearchIndex, snippetOf, terms } from '../src/shared/search.ts';

const now = Date.now();
const session = (id: string, title: string, projectID: string, updated: number): object => ({ id, title, projectID, directory: `/tmp/${projectID}`, time: { created: 1, updated } });
const msg = (id: string, role: string, created: number, text: string): object => ({ info: { id, role, time: { created } }, parts: [{ id: `p${id}`, type: 'text', text }, { id: `t${id}`, type: 'tool', text: 'ignoré' }] });
const data: Record<string, object[]> = {
  ses_a: [msg('m1', 'user', now - 40 * 86_400_000, 'Le Chien de garde du flux SSE'), msg('m2', 'assistant', now - 1000, 'Corrigé : réarmement du chien de garde.')],
  ses_b: [msg('m3', 'user', now - 2000, 'Rien à voir')],
};
let requests = 0;
const fake = {
  url: 'http://test',
  sessions: () => Promise.resolve([session('ses_a', 'Connexion perdue', 'prj_1', now), session('ses_b', 'Garde-robe', 'prj_2', now)]),
  request: (_m: string, path: string) => {
    requests += 1;
    return Promise.resolve(data[/session\/([^/]+)\//u.exec(path)?.[1] ?? ''] ?? []);
  },
};
const file = GLib.build_filenamev([GLib.dir_make_tmp('og-search-XXXXXX'), 'index.json']);
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- client factice
const index = new SearchIndex(fake as unknown as OpencodeClient, file);
const loop = new GLib.MainLoop(null, false);
const check = (what: string, ok: boolean): boolean => {
  if (!ok) print(`échec : ${what}`);
  return ok;
};
const run = async (): Promise<void> => {
  await index.refresh();
  const first = requests;
  const all = [
    check('accents et casse', index.search('CHIEN GARDÉ').length === 2),
    check('outil ignoré', index.search('ignoré').length === 0),
    check('titre', index.search('garde-robe').some((h) => h.text === null && h.session.id === 'ses_b')),
    check('projet', index.search('garde', { project: 'prj_1' }).every((h) => h.session.projectID === 'prj_1')),
    check('période', index.search('chien', { since: now - 7 * 86_400_000 }).length === 1),
    check('plus récent d’abord', index.search('chien')[0]?.text?.message === 'm2'),
    check('extrait', snippetOf('a '.repeat(200) + 'chien', terms('chien')).includes('chien')),
  ];
  // relu depuis le fichier, sans nouvelle requête (sessions inchangées)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- client factice
  const again = new SearchIndex(fake as unknown as OpencodeClient, file);
  await again.refresh();
  all.push(check('cache', requests === first && again.search('chien').length === 2));
  if (all.every(Boolean)) print('TEST OK');
};
void run()
  .catch((e: unknown) => print(`erreur : ${String(e)}`))
  .finally(() => loop.quit());
loop.run();
