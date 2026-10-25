// Lecture des sorties git et graphe des branches.
import { commitGraph, parseStatus, type GitCommit } from '../src/shared/git.ts';

const commit = (hash: string, parents: string[] = []): GitCommit => ({
  hash,
  short: hash,
  parents,
  author: 'T',
  email: 't@t',
  date: 0,
  committer: 'T',
  committed: 0,
  refs: [],
  subject: hash,
  body: '',
});

describe('parseStatus', () => {
  it('lit branche, amont, avance / retard et modifications', () => {
    const out = [
      '# branch.oid a4d53b38b873701090f4d05749cc67ed1da8aa55',
      '# branch.head agent-3',
      '# branch.upstream origin/agent-3',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 abc abc src/a.ts',
      '? notes.txt',
      '',
    ].join('\n');
    expect(parseStatus(out)).toEqual({ branch: 'agent-3', commit: 'a4d53b3', upstream: 'origin/agent-3', ahead: 2, behind: 1, changes: 2 });
  });

  it('HEAD détachée, sans amont ni modification', () => {
    const s = parseStatus('# branch.oid 0123456789abcdef\n# branch.head (detached)\n');
    expect(s.branch).toBeNull();
    expect(s.upstream).toBeNull();
    expect(s.changes).toBe(0);
  });
});

describe('commitGraph', () => {
  it('historique linéaire : une seule voie', () => {
    const g = commitGraph([commit('c', ['b']), commit('b', ['a']), commit('a')]);
    expect(g.width).toBe(1);
    expect(g.rows.map((r) => r.col)).toEqual([0, 0, 0]);
  });

  it('branche fusionnée : ouvre une voie puis la referme', () => {
    // m = fusion de x (main) et f (feature) ; f et x partent de a
    const g = commitGraph([commit('m', ['x', 'f']), commit('f', ['a']), commit('x', ['a']), commit('a')]);
    expect(g.width).toBe(2);
    const [m, f, x, a] = g.rows;
    expect(m?.col).toBe(0);
    // la fusion ouvre une voie vers son second parent
    expect(m?.down.some((e) => e.from === 0 && e.to === 1)).toBeTrue();
    expect(f?.col).toBe(1);
    expect(x?.col).toBe(0);
    // la branche principale garde sa voie et sa couleur
    expect(x?.color).toBe(m?.color);
    // a, parent commun : la voie de f revient sur la voie principale dès x
    expect(x?.down.some((e) => e.from === 1 && e.to === 0)).toBeTrue();
    expect(a?.col).toBe(0);
    expect(a?.up.every((e) => e.from === 0 && e.to === 0)).toBeTrue();
  });
});
