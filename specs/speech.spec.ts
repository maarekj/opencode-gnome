// Texte lu à voix haute : nettoyage du markdown et découpage.
import { chunks, piperVoicePath, speakable, wavFile } from '../src/shared/speech.ts';

describe('speakable', () => {
  it('retire l’emphase, le code en ligne et les liens', () => {
    expect(speakable('Voici **le** _correctif_ dans `store.ts`, voir [la doc](https://x.y/z).')).toBe('Voici le correctif dans store.ts, voir la doc.');
  });

  it('remplace les blocs de code', () => {
    expect(speakable('Avant :\n\n```ts\nconst a = 1;\n```\n\nAprès.')).toBe('Avant :\n(bloc de code)\nAprès.');
  });

  it('termine les titres par un point et retire les puces', () => {
    expect(speakable('## Résumé\n- premier point\n- second point\n1. étape')).toBe('Résumé.\npremier point\nsecond point\nétape');
  });

  it('lit les tableaux cellule par cellule', () => {
    expect(speakable('| Fichier | État |\n|---|:-:|\n| a.ts | modifié |')).toBe('Fichier, État\na.ts, modifié');
  });

  it('réunit les lignes d’un paragraphe et remplace les adresses nues', () => {
    expect(speakable('Une phrase\ncoupée en deux.\n\n> cité https://example.com/a')).toBe('Une phrase coupée en deux.\ncité lien');
  });

  it('ignore les lignes horizontales et le HTML', () => {
    expect(speakable('a\n\n---\n\n<br/>b <kbd>Ctrl</kbd>')).toBe('a\nb Ctrl');
  });

  it('garde les mots avec tiret bas', () => {
    expect(speakable('la variable snake_case_name')).toBe('la variable snake_case_name');
  });
});

describe('chunks', () => {
  it('découpe aux phrases sous la limite', () => {
    const text = 'Une phrase assez longue. '.repeat(10).trim();
    const parts = chunks(text, 60);
    expect(parts.every((p) => p.length <= 60)).toBeTrue();
    expect(parts.join(' ')).toBe(text);
  });

  it('un morceau par paragraphe', () => {
    expect(chunks('a\nb')).toEqual(['a', 'b']);
  });
});

describe('piperVoicePath', () => {
  it('chemin dans rhasspy/piper-voices', () => {
    expect(piperVoicePath('fr_FR-siwis-medium')).toBe('fr/fr_FR/siwis/medium/fr_FR-siwis-medium');
    expect(piperVoicePath('n’importe quoi')).toBeNull();
  });
});

describe('wavFile', () => {
  it('en-tête PCM 16 bits mono', () => {
    const wav = wavFile(new Uint8Array([1, 2, 3, 4]), 16000);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(4);
    expect(Array.from(wav.slice(44))).toEqual([1, 2, 3, 4]);
  });
});
