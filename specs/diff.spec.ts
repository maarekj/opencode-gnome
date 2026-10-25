// Découpage d'un patch unifié (vue des diffs).
import { parsePatch } from '../src/app/DiffView.ts';

const PATCH = `diff --git a/f.txt b/f.txt
index 1..2 100644
--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,3 @@ function main()
 a
-b
+B
 c
\\ No newline at end of file`;

describe('parsePatch', () => {
  it('ignore les en-têtes et numérote les lignes', () => {
    const lines = parsePatch(PATCH);
    expect(lines.map((l) => l.kind)).toEqual(['hunk', 'ctx', 'del', 'add', 'ctx', 'meta']);
    expect(lines[0]?.text).toBe('lignes 1–3 · function main()');
    expect(lines[1]).toEqual({ kind: 'ctx', text: 'a', old: 1, new: 1 });
    expect(lines[2]).toEqual({ kind: 'del', text: 'b', old: 2 });
    expect(lines[3]).toEqual({ kind: 'add', text: 'B', new: 2 });
    expect(lines[4]).toEqual({ kind: 'ctx', text: 'c', old: 3, new: 3 });
  });

  it('bloc sans position (diff reconstitué) : ni séparateur ni numéros', () => {
    expect(parsePatch('@@ @@\n-avant\n+après')).toEqual([
      { kind: 'del', text: 'avant' },
      { kind: 'add', text: 'après' },
    ]);
  });
});
