// Installation locale (développement) :
//  - unité systemd utilisateur `opencode-gnome-server` (opencode serve partagé, port 4096)
//  - ~/.local/bin/oc : opencode console attaché au serveur partagé, dans le répertoire courant
//  - ~/.local/bin/opencode-gnome + fichier .desktop : lance l'application
// À lancer depuis le shell devenv (gjs et ses typelibs sont capturés depuis l'environnement courant).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, buildCli } from './build.ts';

const BASE_ID = 'io.github.maarekj.OpencodeGnome';
const UNIT = 'opencode-gnome-server.service';
const PORT = 4096;

const root = path.resolve(import.meta.dirname, '..');

/**
 * Variante d'installation, déduite du dossier : `opencode-gnome` = principale ; un worktree
 * (`opencode-gnome-2`) = variante « 2 », installée à côté (lanceur, .desktop et identifiant
 * d'application distincts, pour que les deux apparaissent et tournent en même temps).
 */
const variant = path.basename(root).replace(/^opencode-gnome-?/u, '');
const suffix = variant === '' ? '' : `-${variant}`;
const APP_ID = variant === '' ? BASE_ID : `${BASE_ID}.Dev${variant.replaceAll(/[^A-Za-z0-9]/gu, '')}`;
const LAUNCHER = `opencode-gnome${suffix}`;
const home = os.homedir();
const binDir = path.join(home, '.local', 'bin');
const unitDir = path.join(home, '.config', 'systemd', 'user');
const appsDir = path.join(home, '.local', 'share', 'applications');
const dbusDir = path.join(home, '.local', 'share', 'dbus-1', 'services');

const which = (bin: string): string => {
  const found = (process.env['PATH'] ?? '').split(':').map((d) => path.join(d, bin)).find((p) => fs.existsSync(p));
  if (found === undefined) throw new Error(`${bin} introuvable dans le PATH (lance ce script depuis le shell devenv)`);
  return fs.realpathSync(found);
};
/** Valeur d'unité systemd entre guillemets, `%` littéral. */
const unitQuote = (s: string): string => `"${s.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const shq = (s: string): string => `'${s.replaceAll("'", String.raw`'\''`)}'`;
const write = (file: string, content: string, mode = 0o644): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
  console.log(`  ${file.replace(home, '~')}`);
};

// PATH utilisateur hors devenv : celui de la session, sans les entrées /nix/store du shell devenv.
const userPath = (process.env['PATH'] ?? '')
  .split(':')
  .filter((d) => d !== '' && !d.startsWith('/nix/store/') && !d.includes('/.devenv/'))
  .filter((d, i, all) => all.indexOf(d) === i)
  .join(':');

console.log('build…');
await buildApp();
await buildCli();

console.log('fichiers :');
// serveur partagé et `oc` : installés par l'installation principale uniquement
if (variant === '') write(
  path.join(unitDir, UNIT),
  `[Unit]
Description=Serveur opencode partagé (opencode-gnome)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
Environment=${unitQuote(`PATH=${userPath}`)}
ExecStart=${unitQuote(which('opencode'))} serve --hostname 127.0.0.1 --port ${PORT}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`,
);

// plugin opencode : environnement direnv du projet dans les commandes shell des sessions
// (lu au démarrage du serveur : redémarrer le serveur partagé pour le prendre en compte)
const pluginFile = path.join(home, '.config', 'opencode', 'plugins', 'opencode-gnome-direnv.js');
const pluginSource = fs.readFileSync(path.join(root, 'data', 'opencode-plugin', 'direnv.js'), 'utf8');
const pluginChanged = variant === '' && (!fs.existsSync(pluginFile) || fs.readFileSync(pluginFile, 'utf8') !== pluginSource);
if (variant === '') write(pluginFile, pluginSource);

if (variant === '') write(
  path.join(binDir, 'oc'),
  `#!/usr/bin/env bash
# opencode console attaché au serveur partagé d'opencode-gnome, dans le répertoire courant.
# Exemples : oc   |   oc --continue   |   oc --session ses_xxx
set -euo pipefail
url="\${OPENCODE_GNOME_URL:-http://127.0.0.1:${PORT}}"
if ! curl -sf "$url/global/health" >/dev/null 2>&1; then
  systemctl --user start ${UNIT}
  for _ in $(seq 50); do curl -sf "$url/global/health" >/dev/null 2>&1 && break; sleep 0.1; done
fi
exec opencode attach "$url" --dir "$PWD" "$@"
`,
  0o755,
);

write(
  path.join(binDir, LAUNCHER),
  `#!/usr/bin/env bash
# Lance opencode-gnome (version de développement : ${root}).
export OPENCODE_GNOME_APP_ID=${APP_ID}
# tâches planifiées : unités générées vers la CLI ogt de la même version
export OGT_BIN=${shq(path.join(binDir, `ogt${suffix}`))}
export OGT_NAMESPACE=${shq(variant)}
export GI_TYPELIB_PATH=${shq(process.env['GI_TYPELIB_PATH'] ?? '')}\${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}
exec ${shq(which('gjs'))} -m ${shq(path.join(root, 'dist', 'app', 'main.js'))} "$@"
`,
  0o755,
);

// CLI des tâches planifiées : `ogt` (worktree : `ogt-2`, tâches et unités séparées de la version principale)
const OGT = `ogt${suffix}`;
write(
  path.join(binDir, OGT),
  `#!/usr/bin/env bash
# Tâches planifiées d'opencode-gnome (version : ${root}).
export OGT_BIN=${shq(path.join(binDir, OGT))}
export OGT_NAMESPACE=${shq(variant)}
export OPENCODE_GNOME_APP_ID=${APP_ID}
export GI_TYPELIB_PATH=${shq(process.env['GI_TYPELIB_PATH'] ?? '')}\${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}
exec ${shq(which('gjs'))} -m ${shq(path.join(root, 'dist', 'cli', 'ogt.js'))} "$@"
`,
  0o755,
);
// unités des tâches existantes : pointent vers le lanceur à jour
execFileSync(path.join(binDir, OGT), ['sync'], { stdio: 'inherit' });

// Icône (data/icons) installée sous l'identifiant de l'application ; worktree : pastille numérotée.
const iconsDir = path.join(home, '.local', 'share', 'icons', 'hicolor');
const badge =
  variant === ''
    ? ''
    : `  <circle cx="106" cy="106" r="16" fill="#deddda" stroke="#241f31" stroke-width="3"/>
  <text x="106" y="106" dy="0.35em" text-anchor="middle" font-family="Cantarell, sans-serif" font-weight="bold" font-size="${variant.length > 1 ? 13 : 20}" fill="#3d3846">${variant}</text>
`;
const icon = fs.readFileSync(path.join(root, 'data', 'icons', 'app.svg'), 'utf8').replace('</svg>', `${badge}</svg>`);
write(path.join(iconsDir, 'scalable', 'apps', `${APP_ID}.svg`), icon);
write(path.join(iconsDir, 'symbolic', 'apps', `${APP_ID}-symbolic.svg`), fs.readFileSync(path.join(root, 'data', 'icons', 'app-symbolic.svg'), 'utf8'));
try {
  // le thème hicolor n'est relu qu'à la mise à jour de son horodatage
  fs.utimesSync(iconsDir, new Date(), new Date());
} catch {
  // dossier absent : rien à rafraîchir
}

write(
  path.join(appsDir, `${APP_ID}.desktop`),
  `[Desktop Entry]
Type=Application
Name=${variant === '' ? 'opencode' : `opencode (${variant})`}
Comment=Sessions opencode${variant === '' ? '' : ` — worktree ${path.basename(root)}`}
Exec=${path.join(binDir, LAUNCHER)}
Icon=${APP_ID}
Terminal=false
Categories=Development;
StartupNotify=true
DBusActivatable=true
`,
);

// Activation D-Bus : GNOME Shell active les actions des notifications (clic, boutons) via
// org.freedesktop.Application sur le nom de bus de l'application (DBusActivatable=true).
write(
  path.join(dbusDir, `${APP_ID}.service`),
  `[D-BUS Service]
Name=${APP_ID}
Exec=${path.join(binDir, LAUNCHER)} --gapplication-service
`,
);

if (variant === '') {
  console.log('systemd…');
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  execFileSync('systemctl', ['--user', 'enable', '--now', UNIT], { stdio: 'inherit' });
  // pas de redémarrage : il couperait les sessions en cours des agents
  if (pluginChanged) console.log(`plugin direnv installé ou mis à jour : redémarrer le serveur partagé quand aucune session ne tourne (systemctl --user restart ${UNIT})`);
  console.log(`ok — serveur : http://127.0.0.1:${PORT}  ·  console : oc  ·  app : ${LAUNCHER}`);
} else {
  console.log(`ok — app : ${LAUNCHER} (« opencode (${variant}) » dans GNOME), même serveur partagé`);
}
