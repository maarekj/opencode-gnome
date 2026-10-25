// Revue commentée : sélection de lignes d'un diff, prompt envoyé à l'agent.
import { parsePatch, selectionOf } from '../src/shared/diff.ts';
import { reviewPrompt, type ReviewComment } from '../src/shared/review.ts';

const PATCH = ['@@ -10,4 +10,5 @@ fonction', ' a', '-b', '+B', '+C', ' d'].join('\n');

describe('selectionOf', () => {
  const lines = parsePatch(PATCH);
  it('plage en numéros de la nouvelle version, extrait préfixé', () => {
    // 0 : séparateur @@, 1 : « a » (10), 2 : -b, 3 : +B (11), 4 : +C (12)
    expect(selectionOf('f.ts', lines, 1, 4)).toEqual({ file: 'f.ts', lines: 'lignes 10–12', excerpt: ' a\n-b\n+B\n+C', end: { new: 12 } });
    expect(selectionOf('f.ts', lines, 3, 3)?.lines).toBe('ligne 11');
  });
  it('lignes supprimées seules : numéros de l’ancienne version', () => {
    expect(selectionOf('f.ts', lines, 2, 2)?.lines).toBe('ligne 11 (supprimée)');
    expect(selectionOf('f.ts', lines, 2, 2)?.end).toEqual({ old: 11 });
  });
  it('séparateur seul : rien à commenter', () => {
    expect(selectionOf('f.ts', lines, 0, 0)).toBeNull();
  });
});

const c = (file: string, lines: string, text: string, created: number): ReviewComment => ({ id: file + lines, file, lines, source: 'modifications non commitées', excerpt: '+x', text, created });

describe('reviewPrompt', () => {
  it('commentaires par fichier puis par ligne, avec extrait et texte', () => {
    const p = reviewPrompt([c('b.ts', 'ligne 3', 'Renommer', 2), c('a.ts', 'lignes 20–22', 'Gérer null', 3), c('a.ts', 'ligne 5', 'Inutile', 1)]);
    expect(p).toContain('3 commentaires sur 2 fichiers');
    expect(p.indexOf('a.ts — ligne 5')).toBeLessThan(p.indexOf('a.ts — lignes 20–22'));
    expect(p.indexOf('a.ts — lignes 20–22')).toBeLessThan(p.indexOf('b.ts — ligne 3'));
    expect(p).toContain('```diff\n+x\n```\n\nGérer null');
  });
});

describe('reviewPrompt — commentaire général', () => {
  it('ajouté avant les commentaires de lignes, seul s’il n’y en a pas', () => {
    const p = reviewPrompt([c('a.ts', 'ligne 1', 'X', 1)], 'Bon travail, mais simplifie.');
    expect(p.indexOf('## Commentaire général')).toBeLessThan(p.indexOf('a.ts — ligne 1'));
    expect(reviewPrompt([], 'Global seul')).toContain('## Commentaire général\n\nGlobal seul');
  });
});
