// Installation locale (développement) :
//  - unité systemd utilisateur `opencode-gnome-server` (opencode serve partagé, port 4096)
//  - ~/.local/bin/oc : opencode console attaché au serveur partagé, dans le répertoire courant
//  - ~/.local/bin/opencode-gnome + fichier .desktop : lance l'application
// À lancer depuis le shell devenv (gjs et ses typelibs sont capturés depuis l'environnement courant).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from './build.ts';

const APP_ID = 'io.github.maarekj.OpencodeGnome';
const UNIT = 'opencode-gnome-server.service';
const PORT = 4096;

const root = path.resolve(import.meta.dirname, '..');
const home = os.homedir();
const binDir = path.join(home, '.local', 'bin');
const unitDir = path.join(home, '.config', 'systemd', 'user');
const appsDir = path.join(home, '.local', 'share', 'applications');

const which = (bin: string): string => {
  const found = (process.env['PATH'] ?? '').split(':').map((d) => path.join(d, bin)).find((p) => fs.existsSync(p));
  if (found === undefined) throw new Error(`${bin} introuvable dans le PATH (lance ce script depuis le shell devenv)`);
  return fs.realpathSync(found);
};
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

console.log('fichiers :');
write(
  path.join(unitDir, UNIT),
  `[Unit]
Description=Serveur opencode partagé (opencode-gnome)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
Environment=PATH=${userPath}
ExecStart=${which('opencode')} serve --hostname 127.0.0.1 --port ${PORT}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`,
);

write(
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
  path.join(binDir, 'opencode-gnome'),
  `#!/usr/bin/env bash
# Lance opencode-gnome (version de développement : ${root}).
export GI_TYPELIB_PATH=${shq(process.env['GI_TYPELIB_PATH'] ?? '')}\${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}
exec ${shq(which('gjs'))} -m ${shq(path.join(root, 'dist', 'app', 'main.js'))} "$@"
`,
  0o755,
);

write(
  path.join(appsDir, `${APP_ID}.desktop`),
  `[Desktop Entry]
Type=Application
Name=opencode
Comment=Sessions opencode
Exec=${path.join(binDir, 'opencode-gnome')}
Icon=utilities-terminal
Terminal=false
Categories=Development;
StartupNotify=true
DBusActivatable=false
`,
);

console.log('systemd…');
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'enable', '--now', UNIT], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'restart', UNIT], { stdio: 'inherit' });
console.log(`ok — serveur : http://127.0.0.1:${PORT}  ·  console : oc  ·  app : opencode-gnome`);
