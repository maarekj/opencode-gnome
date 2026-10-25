// Recherche dans les conversations (#126, SQLite FTS5 : #130) : index construit par l'API,
// recherche sans accents ni casse (tous les termes, milieu de mot, termes courts), titres,
// filtres projet et période, extrait.
import GLib from 'gi://GLib';
import type { OpencodeClient } from '../src/shared/client.ts';
import { SearchIndex, snippetOf, terms } from '../src/shared/search.ts';

const now = Date.now();
const session = (id: string, title: string, projectID: string, updated: number): object => ({ id, title, projectID, directory: `/tmp/${projectID}`, time: { created: 1, updated } });
const msg = (id: string, role: string, created: number, text: string): object => ({ info: { id, role, time: { created } }, parts: [{ id: `p${id}`, type: 'text', text }, { id: `t${id}`, type: 'tool', text: 'ignoré' }] });
const data: Record<string, object[]> = {
  ses_a: [msg('m1', 'user', now - 40 * 86_400_000, 'Le Chien de garde du flux SSE'), msg('m2', 'assistant', now - 1000, 'Corrigé : réarmement du chien de garde.')],
  ses_b: [msg('m3', 'user', now - 2000, 'Rien à voir'), msg('m4', 'assistant', now - 3000, String.raw`chemin C:\Temp\ et echo \'oblique\' ; "guillemets"`)],
};
let requests = 0;
const fake = {
  url: 'http://test',
  sessions: () => Promise.resolve([session('ses_a', 'Connexion perdue', 'prj_1', now), session('ses_b', 'Garde-robe', 'prj_2', now)]),
  // deux pages : le message le plus ancien, puis les autres
  messagePage: (id: string, _limit: number, before?: string) => {
    requests += 1;
    const all = data[id] ?? [];
    return Promise.resolve(before === undefined ? { messages: all.slice(1), older: all.length > 1 ? 'p1' : null } : { messages: all.slice(0, 1), older: null });
  },
};
const file = GLib.build_filenamev([GLib.dir_make_tmp('og-search-XXXXXX'), 'index']);
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- client factice
const index = new SearchIndex(fake as unknown as OpencodeClient, file);
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
    check('milieu de mot', index.search('arme').length === 1),
    check('terme court', index.search('du sse').length === 1),
    check('terme court accentué', index.search('à voir').length === 1),
    check('apostrophe', index.search("l'eau").length === 0),
    check('barre oblique inverse', index.search('oblique').length === 1 && index.search(String.raw`C:\Temp`).length === 1),
    check('extrait', snippetOf('a '.repeat(200) + 'chien', terms('chien')).includes('chien')),
  ];
  // relu depuis le fichier, sans nouvelle requête (sessions inchangées)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- client factice
  const again = new SearchIndex(fake as unknown as OpencodeClient, file);
  await again.refresh();
  all.push(check('cache', requests === first && again.search('chien').length === 2));
  if (all.every(Boolean)) print('TEST OK');
};
// await au niveau du module (pas de MainLoop : search.ts charge libgda par un import dynamique
// au niveau du module, dont les promesses ne seraient pas traitées dans une boucle bloquante)
await run().catch((e: unknown) => print(`erreur : ${String(e)}`));
