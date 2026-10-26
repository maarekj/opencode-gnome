// Hiérarchie des projets (sous-projets sous leur ancêtre).
import { descendantsOf, moveChild, parentOf, projectTree } from '../src/shared/projecttree.ts';

const C = '/home/u/projects/claude';
const A = `${C}/appartement netivot`;
const B = `${C}/budget`;
const X = '/home/u/projects/claude-code';
const D = `${A}/devis`;

describe('projectTree', () => {
  it('range les sous-projets sous leur ancêtre le plus proche', () => {
    const t = projectTree([X, A, C, D, B]);
    expect(t.map((n) => `${'  '.repeat(n.depth)}${n.path.slice(17)}`)).toEqual(['claude-code', 'claude', '  claude/appartement netivot', '    claude/appartement netivot/devis', '  claude/budget']);
    expect(t.find((n) => n.path === D)?.parent).toBe(A);
  });

  it('préfixe de nom sans être un dossier parent : pas de lien', () => {
    expect(parentOf(X, [C])).toBeNull();
  });

  it('ordre choisi entre frères, les autres ensuite', () => {
    const t = projectTree([C, A, B], { [C]: [B] });
    expect(t.map((n) => n.path)).toEqual([C, B, A]);
  });

  it('ancêtre absent (mode Favoris) : sous-projet au premier niveau', () => {
    expect(projectTree([A, X]).map((n) => n.depth)).toEqual([0, 0]);
  });

  it('descendants et déplacement', () => {
    expect(descendantsOf(C, [X, A, D, B, C])).toEqual([A, D, B]);
    expect(moveChild([A, B, D], D, A)).toEqual([D, A, B]);
    expect(moveChild([A, B], A, null)).toEqual([B, A]);
  });
});
