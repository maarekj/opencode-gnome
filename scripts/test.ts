// Tests GJS sous Xvfb, bundlés par esbuild :
// 1. specs unitaires jasmine-gjs (specs/*.spec.ts, describe / it / expect) ;
// 2. tests GTK (tests/*.ts) : échec sur avertissement GTK, délai dépassé (boucle infinie) ou
//    absence de « TEST OK ».
// `pnpm test specs/git.spec.ts` : une seule spec (les tests GTK ne sont alors pas lancés).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const ENV = ['GDK_BACKEND=x11', 'GSK_RENDERER=cairo', 'GTK_A11Y=none'];

// ---------------------------------------------------------------- specs jasmine-gjs
const only = process.argv.slice(2).filter((a) => a.endsWith('.spec.ts'));
const specsOut = path.join(root, 'dist', 'specs');
fs.rmSync(specsOut, { recursive: true, force: true });
const specs =
  only.length > 0
    ? only.map((s) => path.resolve(s))
    : fs
        .readdirSync(path.join(root, 'specs'))
        .filter((f) => f.endsWith('.spec.ts'))
        .map((f) => path.join(root, 'specs', f));
await build({ entryPoints: specs, outdir: specsOut, bundle: true, format: 'esm', target: 'es2022', external: ['gi://*', 'system', 'cairo'], logLevel: 'warning' });
const jasmine = spawnSync('xvfb-run', ['-a', 'env', ...ENV, 'jasmine', '--module', '--no-config', specsOut], { stdio: 'inherit' });
if (jasmine.status !== 0) {
  console.log('ÉCHEC specs jasmine');
  process.exit(1);
}
if (only.length > 0) process.exit(0);

// ---------------------------------------------------------------- tests GTK
const out = path.join(root, 'dist', 'tests');
const tests = fs.readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.ts'));
const file = (t: string): string => path.join(out, t.replace(/\.ts$/u, '.js'));
await Promise.all(
  tests.map((t) => build({ entryPoints: [path.join(root, 'tests', t)], outfile: file(t), bundle: true, format: 'esm', target: 'es2022', external: ['gi://*', 'system', 'gettext', 'cairo'], tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'gnim/gtk4', experimentalDecorators: false } }, logLevel: 'warning' })),
);
let failed = 0;
for (const t of tests) {
  const res = spawnSync('xvfb-run', ['-a', 'env', ...ENV, 'timeout', '10', 'gjs', '-m', file(t)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${res.stdout}${res.stderr}`;
  const warnings = output.split('\n').filter((l) => /Gtk-(WARNING|CRITICAL)/u.test(l));
  const ok = res.status === 0 && output.includes('TEST OK') && warnings.length === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'ÉCHEC'} ${t}${ok ? '' : ` (code ${res.status ?? 'délai'}, ${warnings.length} avertissement(s))\n${warnings.slice(0, 3).join('\n')}`}`);
}
if (failed > 0) process.exit(1);
