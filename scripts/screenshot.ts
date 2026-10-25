// Lance l'application sur un écran X virtuel (Xvfb) et en prend une capture, sans rien afficher à l'écran.
// Usage : node scripts/screenshot.ts [sortie.png] [-- arguments de l'app, ex. --session ses_xxx]
// Variables : SCREENSHOT_DELAY (s, défaut 4), SCREENSHOT_SIZE (défaut 1280x800),
// SCREENSHOT_XDOTOOL : commandes xdotool jouées avant la capture, séparées par « ; »
// (ex. « mousemove 700 180 click 1; type bonjour; key ctrl+Return; sleep 2 » ;
// « sh: commande » exécute une commande shell, ex. xclip pour remplir le presse-papier).
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
  // OPENCODE_GNOME_SANDBOX : dossiers, fichiers, liens, terminaux et systemctl journalisés au lieu
  // d'être lancés dans la session de l'utilisateur
  `export GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none GDK_DEBUG=no-portals GIO_USE_VFS=local OPENCODE_GNOME_SANDBOX=1`,
  `timeout ${Number(delay) + (process.env['SCREENSHOT_XDOTOOL'] === undefined ? 3 : 120)} dbus-run-session -- gjs -m ${quote(path.join(root, 'dist', 'app', 'main.js'))} --size ${w}x${h} ${appArgs.map((a) => quote(a)).join(' ')} > >(grep -v -e '^dbus-daemon' -e 'DRI3') 2>&1 &`,
  'app=$!',
  `sleep ${delay}`,
  ...(process.env['SCREENSHOT_XDOTOOL'] ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c !== '')
    // « sleep … » et « sh: … » (commande shell) tels quels, le reste passé à xdotool
    .map((c) => (c.startsWith('sleep ') ? c : c.startsWith('sh:') ? c.slice(3) : `xdotool ${c}`)),
  'sleep 1',
  `import -window root ${quote(out)}`,
  // l'app est arrêtée une fois la capture prise
  'kill $app 2>/dev/null || true',
  `wait`,
].join('\n');
execFileSync('xvfb-run', ['-a', '-s', `-screen 0 ${w}x${h}x24`, 'bash', '-c', script], { stdio: 'inherit' });
console.log(out);
