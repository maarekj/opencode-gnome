// Appel d'outil `read` : chemin, plage lue, contenu renuméroté.
import { readInfo } from '../src/shared/toolread.ts';

const state = (input: object, output: string, metadata?: object): Parameters<typeof readInfo>[0] => ({ status: 'completed', input, output, ...(metadata === undefined ? {} : { metadata }) });

describe('outil read', () => {
  it('metadata.display : fichier entier', () => {
    const info = readInfo(state({ filePath: '/p/a.ts' }, '', { display: { text: 'un\ndeux\n', lineStart: 1, lineEnd: 2, totalLines: 2 } }));
    expect(info).toEqual({ path: '/p/a.ts', directory: false, range: '2 lignes', text: '1  un\n2  deux' });
  });

  it('metadata.display : extrait, numéros alignés', () => {
    const info = readInfo(state({ filePath: '/p/a.ts' }, '', { display: { text: 'a\nb', lineStart: 9, lineEnd: 10, totalLines: 50 } }));
    expect(info?.range).toBe('lignes 9–10 sur 50');
    expect(info?.text).toBe(' 9  a\n10  b');
  });

  it('sortie brute : enveloppe retirée, plage lue dans la note finale', () => {
    const out = '<path>/p/s.ts</path>\n<type>file</type>\n<content>\n120: export function listen() {\n121:   return port;\n\n(Showing lines 120-159 of 300. Use offset=160 to continue.)\n</content>';
    const info = readInfo(state({ filePath: '/p/s.ts', offset: 120, limit: 40 }, out));
    expect(info?.range).toBe('lignes 120–159 sur 300');
    expect(info?.text).toBe('120  export function listen() {\n121    return port;');
  });

  it('sortie brute : fin de fichier', () => {
    const out = '<path>/p/a.ts</path>\n<type>file</type>\n<content>\n1: x\n\n(End of file - total 1 lines)\n</content>';
    expect(readInfo(state({ filePath: '/p/a.ts' }, out))?.range).toBe('1 ligne');
  });

  it('dossier', () => {
    const out = '<path>/p</path>\n<type>directory</type>\n<entries>\nsrc/\na.ts\n\n(2 entries)\n</entries>';
    expect(readInfo(state({ filePath: '/p' }, out))).toEqual({ path: '/p', directory: true, range: 'dossier', text: 'src/\na.ts' });
  });

  it('sans chemin : pas de ligne dédiée', () => {
    expect(readInfo(state({}, ''))).toBeNull();
  });
});
