// Décodage par morceaux des grosses réponses (#163).
import { decodeLarge, utf8Boundary } from '../src/shared/client.ts';

describe('decodeLarge', () => {
  const text = 'é€😀a'.repeat(50);
  const bytes = new TextEncoder().encode(text);

  it('ne coupe jamais un caractère multi-octets', async () => {
    for (const chunk of [4, 5, 6, 7, 11]) {
      // oxlint-disable-next-line no-await-in-loop -- tailles testées l'une après l'autre
      expect(await decodeLarge(bytes, chunk)).toBe(text);
    }
  });

  it('recule jusqu’au début du caractère', () => {
    const euro = new TextEncoder().encode('a€'); // 61 e2 82 ac
    expect(utf8Boundary(euro, 2)).toBe(1);
    expect(utf8Boundary(euro, 3)).toBe(1);
    expect(utf8Boundary(euro, 1)).toBe(1);
    expect(utf8Boundary(euro, 9)).toBe(4);
  });
});
