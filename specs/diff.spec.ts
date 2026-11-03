// Découpage d'un patch unifié (vue des diffs).
import { diffMarkers, markerY, parsePatch, valueAtMarker } from '../src/shared/diff.ts';

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

describe('diffMarkers', () => {
  it('regroupe ajouts et suppressions consécutifs', () => {
    const lines = parsePatch(`@@ -1,6 +1,6 @@
 a
-b
+B
 c
+d
 e
-f`);
    // hunk, a, -b, +B, c, +d, e, -f
    expect(diffMarkers(lines)).toEqual([
      { start: 2, end: 4, kind: 'change' },
      { start: 5, end: 6, kind: 'add' },
      { start: 7, end: 8, kind: 'del' },
    ]);
  });
  it('une ligne de commentaire ne coupe pas un bloc', () => {
    const lines = [...parsePatch(`@@ -1,1 +1,2 @@
+x`), null, ...parsePatch(`@@ -1,1 +1,2 @@
+y`).slice(1)];
    expect(diffMarkers(lines)).toEqual([{ start: 1, end: 4, kind: 'add' }]);
  });
});

describe('markerY / valueAtMarker', () => {
  const track = { top: 10, height: 500, slider: 40 };
  it('aligne le repère sur le milieu du curseur quand la ligne est au milieu de la vue', () => {
    // ligne au milieu de la vue : value = lineY - page / 2 = 900 ; curseur : 10 + 20 + 900/1800 * 460
    expect(markerY(1000, 2000, 200, track)).toBe(10 + 20 + 230);
    expect(valueAtMarker(260, 2000, 200, track)).toBe(900);
  });
  it('début et fin bornés', () => {
    expect(markerY(0, 2000, 200, track)).toBe(30);
    expect(markerY(2000, 2000, 200, track)).toBe(490);
    expect(valueAtMarker(0, 2000, 200, track)).toBe(0);
  });
  it('contenu sans défilement : position proportionnelle', () => {
    expect(markerY(50, 100, 200, track)).toBe(10 + 125);
    expect(valueAtMarker(300, 100, 200, track)).toBe(0);
  });
});
