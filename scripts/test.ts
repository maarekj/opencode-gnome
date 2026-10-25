// Tests GJS sous Xvfb (tests/*.ts, bundlés par esbuild). Échec : avertissement GTK, délai
// dépassé (boucle infinie) ou absence de « TEST OK ».
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist', 'tests');
const tests = fs.readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.ts'));
const file = (t: string): string => path.join(out, t.replace(/\.ts$/u, '.js'));
await Promise.all(
  tests.map((t) => build({ entryPoints: [path.join(root, 'tests', t)], outfile: file(t), bundle: true, format: 'esm', target: 'es2022', external: ['gi://*', 'system', 'gettext', 'cairo'], tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'gnim/gtk4', experimentalDecorators: false } }, logLevel: 'warning' })),
);
let failed = 0;
for (const t of tests) {
  const res = spawnSync('xvfb-run', ['-a', 'env', 'GDK_BACKEND=x11', 'GSK_RENDERER=cairo', 'GTK_A11Y=none', 'timeout', '10', 'gjs', '-m', file(t)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${res.stdout}${res.stderr}`;
  const warnings = output.split('\n').filter((l) => /Gtk-(WARNING|CRITICAL)/u.test(l));
  const ok = res.status === 0 && output.includes('TEST OK') && warnings.length === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'ÉCHEC'} ${t}${ok ? '' : ` (code ${res.status ?? 'délai'}, ${warnings.length} avertissement(s))\n${warnings.slice(0, 3).join('\n')}`}`);
}
if (failed > 0) process.exit(1);
