// Ordre fixe de la barre latérale (favoris, sessions ouvertes) : déplacement par glisser-déposer.
import { moveBefore } from '../src/shared/settings.ts';

describe('moveBefore', () => {
  it('place l’élément avant la cible', () => {
    expect(moveBefore(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(moveBefore(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'a', 'c']);
  });
  it('à la fin si la cible est null ou absente', () => {
    expect(moveBefore(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a']);
    expect(moveBefore(['a', 'b'], 'a', 'z')).toEqual(['b', 'a']);
  });
  it('ne change rien si l’élément est absent ou sur lui-même', () => {
    expect(moveBefore(['a', 'b'], 'z', 'a')).toEqual(['a', 'b']);
    expect(moveBefore(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
  });
});
