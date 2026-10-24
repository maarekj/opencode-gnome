// Plugin opencode installé par opencode-gnome (scripts/install.ts) : charge l'environnement
// direnv du projet (.envrc, devenv…) dans chaque commande shell des sessions. Le serveur partagé
// tourne en service systemd : sans ce plugin, les commandes héritent de son environnement à lui.
//
// `direnv export json` dans le dossier de la commande ; résultat en cache par .envrc, invalidé
// quand .envrc ou les fichiers qu'il surveille changent (direnv les liste dans DIRENV_WATCHES).
// Aucun .envrc, .envrc non autorisé, direnv absent, erreur ou délai dépassé : rien d'ajouté.
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** devenv peut être long au premier chargement (évaluation nix) */
const TIMEOUT_MS = 120_000;

/** .envrc -> { stamp, env } */
const cache = new Map();
/** .envrc -> chargement en cours (commandes simultanées) */
const pending = new Map();

function findEnvrc(dir) {
  for (let d = dir; ; d = dirname(d)) {
    const f = join(d, '.envrc');
    if (existsSync(f)) return f;
    if (dirname(d) === d) return null;
  }
}

const mtime = (f) => {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};

/** Empreinte : .envrc et fichiers surveillés par direnv (devenv.nix, devenv.lock, flake.lock…). */
function stamp(envrc, watched) {
  return [envrc, ...watched].map((f) => `${f}:${mtime(f)}`).join('|');
}

/** Fichiers surveillés, décodés depuis DIRENV_WATCHES (base64url de zlib JSON) : best effort. */
async function watchesOf(value) {
  if (typeof value !== 'string' || value === '') return [];
  try {
    const { inflateSync } = await import('node:zlib');
    const json = JSON.parse(inflateSync(Buffer.from(value, 'base64url')).toString());
    return Array.isArray(json) ? json.map((w) => w.path).filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function direnvExport(dir, baseEnv) {
  return new Promise((resolve) => {
    execFile('direnv', ['export', 'json'], { cwd: dir, env: baseEnv, timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err !== null) {
        resolve({ ok: false, error: (stderr || err.message).trim().split('\n').at(-1) ?? '' });
        return;
      }
      try {
        resolve({ ok: true, env: stdout.trim() === '' ? {} : JSON.parse(stdout) });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  });
}

async function load(envrc, log) {
  const dir = dirname(envrc);
  // environnement du serveur sans traces d'un direnv déjà chargé : export complet
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith('DIRENV_')) delete base[k];
  const t0 = Date.now();
  const res = await direnvExport(dir, base);
  if (!res.ok) {
    await log('warn', `direnv ignoré pour ${dir} : ${res.error}`);
    return { stamp: stamp(envrc, []), env: {} };
  }
  // null = variable retirée par direnv : on ne peut que la vider
  const env = {};
  for (const [k, v] of Object.entries(res.env)) if (!k.startsWith('DIRENV_')) env[k] = v ?? '';
  const watched = await watchesOf(res.env.DIRENV_WATCHES);
  await log('info', `direnv chargé pour ${dir} : ${Object.keys(env).length} variable(s) en ${Date.now() - t0} ms`);
  return { stamp: stamp(envrc, watched), env, watched };
}

export const OpencodeGnomeDirenv = async ({ client }) => {
  const log = async (level, message) => {
    try {
      await client.app.log({ body: { service: 'opencode-gnome-direnv', level, message } });
    } catch {
      // journal indisponible
    }
  };
  const available = await new Promise((resolve) => execFile('direnv', ['version'], (err) => resolve(err === null)));
  if (!available) {
    await log('warn', 'direnv introuvable : environnement des projets non chargé');
    return {};
  }
  return {
    'shell.env': async (input, output) => {
      const envrc = findEnvrc(input.cwd);
      if (envrc === null) return;
      let entry = cache.get(envrc);
      if (entry === undefined || entry.stamp !== stamp(envrc, entry.watched ?? [])) {
        let p = pending.get(envrc);
        if (p === undefined) {
          p = load(envrc, log).finally(() => pending.delete(envrc));
          pending.set(envrc, p);
        }
        entry = await p;
        cache.set(envrc, entry);
      }
      Object.assign(output.env, entry.env);
    },
  };
};
