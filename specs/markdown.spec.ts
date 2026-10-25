// Analyse markdown → blocs et balisage Pango.
import { escapeMarkup, inline, parseMarkdown } from '../src/shared/markdown.ts';

describe('markdown', () => {
  it('échappe le balisage Pango', () => {
    expect(escapeMarkup('a < b & "c"')).toBe('a &lt; b &amp; &quot;c&quot;');
  });

  it('styles en ligne', () => {
    expect(inline('**gras** et *italique*')).toContain('<b>gras</b>');
    expect(inline('**gras** et *italique*')).toContain('<i>italique</i>');
  });

  it('découpe en blocs : titre, liste, code', () => {
    const blocks = parseMarkdown('# Titre\n\n- un\n- deux\n\n```\ncode\n```');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'item', 'item', 'code']);
    expect(blocks[3]).toEqual({ kind: 'code', text: 'code' });
  });
});
