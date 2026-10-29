// Disposition de la barre d'un projet : terminaux et liens mélangés, dossiers (#145).
import { addFolder, findFolder, folderOf, keyOf, moveEntry, normalizeLayout, removeFolder, renameFolder, type LayoutEntry } from '../src/shared/layout.ts';

const T = [{ id: 't1' }, { id: 't2' }];
const L = [{ id: 'l1' }, { id: 'l2' }];
const keys = (l: readonly LayoutEntry[]): string[] => l.map((e) => ('folder' in e ? `${keyOf(e)}[${e.items.map(keyOf).join(',')}]` : keyOf(e)));

describe('disposition de la barre', () => {
  it('sans disposition : terminaux puis liens', () => {
    expect(keys(normalizeLayout(undefined, T, L))).toEqual(['terminal:t1', 'terminal:t2', 'link:l1', 'link:l2']);
  });

  it('devenv : référence et ajout à la fin', () => {
    expect(keys(normalizeLayout([{ devenv: 'd1' }, { devenv: 'zz' }], T, [], [{ id: 'd1' }, { id: 'd2' }]))).toEqual(['devenv:d1', 'terminal:t1', 'terminal:t2', 'devenv:d2']);
  });

  it('orphelins et doublons retirés, manquants ajoutés à la fin', () => {
    const l = normalizeLayout([{ link: 'l2' }, { terminal: 'zz' }, { folder: 'f', name: 'F', items: [{ terminal: 't2' }, { link: 'l2' }] }], T, L);
    expect(keys(l)).toEqual(['link:l2', 'folder:f[terminal:t2]', 'terminal:t1', 'link:l1']);
  });

  it('déplacements : mélange, dans un dossier, hors du dossier', () => {
    let l = addFolder(normalizeLayout(undefined, T, L), 'f', 'worktree 1');
    l = moveEntry(l, 'link:l1', null, 'terminal:t1');
    expect(keys(l)).toEqual(['link:l1', 'terminal:t1', 'terminal:t2', 'link:l2', 'folder:f[]']);
    l = moveEntry(l, 'terminal:t2', 'f', null);
    l = moveEntry(l, 'link:l2', 'f', 'terminal:t2');
    expect(keys(l)).toEqual(['link:l1', 'terminal:t1', 'folder:f[link:l2,terminal:t2]']);
    expect(folderOf(l, 'terminal:t2')).toBe('f');
    l = moveEntry(l, 'terminal:t2', null, 'link:l1');
    expect(keys(l)).toEqual(['terminal:t2', 'link:l1', 'terminal:t1', 'folder:f[link:l2]']);
    // un dossier ne va pas dans un dossier ; dossier inconnu : rien
    expect(keys(moveEntry(l, 'folder:f', 'f', null))).toEqual(keys(l));
    expect(keys(moveEntry(l, 'link:l1', 'inconnu', null))).toEqual(keys(l));
    // dossier déplacé au premier niveau
    expect(keys(moveEntry(l, 'folder:f', null, 'terminal:t2'))[0]).toBe('folder:f[link:l2]');
  });

  it('renommer, retrouver, supprimer un dossier (contenu remis à sa place)', () => {
    let l: LayoutEntry[] = [{ terminal: 't1' }, { folder: 'f', name: 'A', items: [{ link: 'l1' }, { terminal: 't2' }] }, { link: 'l2' }];
    l = renameFolder(l, 'f', 'B');
    expect(findFolder(l, 'B')?.folder).toBe('f');
    expect(findFolder(l, 'f')?.name).toBe('B');
    expect(keys(removeFolder(l, 'f'))).toEqual(['terminal:t1', 'link:l1', 'terminal:t2', 'link:l2']);
  });
});
