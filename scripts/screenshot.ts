// Lance l'application sur un écran X virtuel (Xvfb) et en prend une capture, sans rien afficher à l'écran.
// Usage : node scripts/screenshot.ts [sortie.png] [-- arguments de l'app, ex. --session ses_xxx]
// Variables : SCREENSHOT_DELAY (s, défaut 4), SCREENSHOT_SIZE (défaut 1280x800).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { buildApp } from './build.ts';

const root = path.resolve(import.meta.dirname, '..');
const sep = process.argv.indexOf('--');
const own = sep === -1 ? process.argv.slice(2) : process.argv.slice(2, sep);
const appArgs = sep === -1 ? [] : process.argv.slice(sep + 1);
const out = path.resolve(own[0] ?? path.join(root, 'dist', 'screenshot.png'));
const delay = process.env['SCREENSHOT_DELAY'] ?? '4';
const size = process.env['SCREENSHOT_SIZE'] ?? '1280x800';
const [w = '1280', h = '800'] = size.split('x');

await buildApp();
const quote = (s: string): string => `'${s.replaceAll("'", String.raw`'\''`)}'`;
const script = [
  // écran X virtuel, bus D-Bus privé (pas de contact avec une instance déjà ouverte),
  // sans accessibilité ni portails (absents de ce bus privé)
  `export GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none GDK_DEBUG=no-portals GIO_USE_VFS=local`,
  `timeout ${Number(delay) + 3} dbus-run-session -- gjs -m ${quote(path.join(root, 'dist', 'app', 'main.js'))} --size ${w}x${h} ${appArgs.map((a) => quote(a)).join(' ')} 2>&1 | grep -v -e '^dbus-daemon' -e 'DRI3' &`,
  `sleep ${delay}`,
  `import -window root ${quote(out)}`,
  `wait`,
].join('\n');
execFileSync('xvfb-run', ['-a', '-s', `-screen 0 ${w}x${h}x24`, 'bash', '-c', script], { stdio: 'inherit' });
console.log(out);
