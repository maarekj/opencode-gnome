// Arborescence des fichiers modifiés.
import { fileTree } from '../src/shared/filetree.ts';

const f = (path: string, additions: number | null = 1, deletions: number | null = 0) => ({ path, additions, deletions });

describe('fileTree', () => {
  const files = [f('src/app/a.ts', 3, 1), f('src/app/b.ts', 2, 2), f('src/shared/c.ts'), f('README.md', 1, 1), f('docs/guide/intro.md')];

  it('dossiers avant fichiers, triés, avec décomptes', () => {
    const rows = fileTree(files);
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.label}`)).toEqual(['docs/guide', '  intro.md', 'src', '  app', '    a.ts', '    b.ts', '  shared', '    c.ts', 'README.md']);
    const src = rows.find((r) => r.kind === 'dir' && r.path === 'src');
    expect(src).toEqual(jasmine.objectContaining({ files: 3, additions: 6, deletions: 3 }));
  });

  it('fusionne les chaînes de dossiers uniques', () => {
    const rows = fileTree([f('a/b/c/x.ts'), f('a/b/c/y.ts')]);
    expect(rows[0]).toEqual(jasmine.objectContaining({ kind: 'dir', path: 'a/b/c', label: 'a/b/c' }));
  });

  it('dossier replié : contenu omis', () => {
    const rows = fileTree(files, new Set(['src']));
    expect(rows.map((r) => r.label)).toEqual(['docs/guide', 'intro.md', 'src', 'README.md']);
  });

  it('fichiers binaires : pas de lignes comptées', () => {
    const rows = fileTree([f('img/a.png', null, null), f('img/b.ts', 2, 1)]);
    expect(rows[0]).toEqual(jasmine.objectContaining({ files: 2, additions: 2, deletions: 1 }));
  });
});
