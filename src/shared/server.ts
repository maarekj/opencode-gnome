// Serveur opencode partagé (unité systemd utilisateur `opencode-gnome-server`) : état, contrôle,
// journal, et accès depuis le réseau. Réglages d'accès dans ~/.config/opencode-gnome/server.env
// (0600), lu par l'unité (EnvironmentFile) et par les clients (mot de passe HTTP Basic).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as z from 'zod/mini';
import { DEFAULT_PORT } from './config.ts';
import { intercepted } from './sandbox.ts';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

/** Unité du serveur ; OPENCODE_GNOME_SERVER_UNIT pour les tests (unité de test, contrôlée pour de vrai). */
export const serverUnit = (): string => GLib.getenv('OPENCODE_GNOME_SERVER_UNIT') ?? 'opencode-gnome-server.service';
const testUnit = (): boolean => GLib.getenv('OPENCODE_GNOME_SERVER_UNIT') !== null;

export const serverEnvPath = (): string => GLib.build_filenamev([GLib.get_user_config_dir(), 'opencode-gnome', 'server.env']);

export interface ServerAccess {
  /** écoute sur toutes les interfaces (0.0.0.0) au lieu de 127.0.0.1 */
  readonly network: boolean;
  /** mot de passe HTTP Basic (utilisateur `opencode`) ; vide = aucun */
  readonly password: string;
}

const decoder = new TextDecoder();

/** Caractères refusés dans le mot de passe (fichier d'environnement systemd, script shell, en-tête). */
export const PASSWORD_FORBIDDEN = /["'\\$`\s]/u;
const unquote = (v: string): string => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

/** Lit server.env (absent : accès local sans mot de passe). */
export function readServerAccess(path = serverEnvPath()): ServerAccess {
  let text = '';
  try {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (ok) text = decoder.decode(bytes);
  } catch {
    // absent
  }
  const env = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (m !== null) env.set(m[1] ?? '', unquote((m[2] ?? '').trim()));
  }
  return { network: env.get('OPENCODE_GNOME_HOST') === '0.0.0.0', password: env.get('OPENCODE_SERVER_PASSWORD') ?? '' };
}

export function writeServerAccess(access: ServerAccess, path = serverEnvPath()): void {
  if (PASSWORD_FORBIDDEN.test(access.password)) throw new Error('Mot de passe : espaces, guillemets, \\, $ et ` interdits');
  const lines = [
    '# Généré par opencode-gnome (fenêtre « Serveur opencode ») : lu par opencode-gnome-server.service',
    `OPENCODE_GNOME_HOST=${access.network ? '0.0.0.0' : '127.0.0.1'}`,
    ...(access.password === '' ? [] : [`OPENCODE_SERVER_PASSWORD="${access.password}"`]),
    '',
  ];
  GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
  GLib.file_set_contents(path, new TextEncoder().encode(lines.join('\n')));
  // contient un mot de passe : lisible par l'utilisateur seul
  Gio.File.new_for_path(path).set_attribute_uint32('unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
}

/** Mot de passe envoyé par les clients : OPENCODE_SERVER_PASSWORD, sinon server.env. */
export function serverPassword(): string {
  return GLib.getenv('OPENCODE_SERVER_PASSWORD') ?? readServerAccess().password;
}

/** Mot de passe aléatoire lisible (proposition, modifiable). */
export function randomPassword(length = 20): string {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length }, () => chars[GLib.random_int_range(0, chars.length)] ?? 'x').join('');
}

// ------------------------------------------------------------------ systemd

async function run(argv: readonly string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Gio.Subprocess.new([...argv], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
  const [out] = await proc.communicate_utf8_async(null, null);
  return { ok: proc.get_successful(), out: out ?? '' };
}

export interface UnitState {
  readonly installed: boolean;
  /** active, inactive, failed, activating… */
  readonly active: string;
  readonly sub: string;
  /** démarrage (ms), si actif */
  readonly since: number | null;
  readonly pid: number | null;
  /** ligne de commande lancée */
  readonly command: string;
}

export async function unitState(): Promise<UnitState> {
  const { out } = await run(['systemctl', '--user', 'show', serverUnit(), '--timestamp=unix', '-p', 'LoadState,ActiveState,SubState,MainPID,ActiveEnterTimestamp,ExecStart']);
  const get = (k: string): string => new RegExp(`^${k}=(.*)$`, 'mu').exec(out)?.[1] ?? '';
  const since = /@(\d+)/u.exec(get('ActiveEnterTimestamp'))?.[1];
  const pid = Number(get('MainPID'));
  const argv = /argv\[\]=([^;]*)/u.exec(get('ExecStart'))?.[1]?.trim() ?? '';
  return {
    installed: get('LoadState') === 'loaded',
    active: get('ActiveState'),
    sub: get('SubState'),
    since: get('ActiveState') === 'active' && since !== undefined ? Number(since) * 1000 : null,
    pid: pid > 0 ? pid : null,
    command: argv,
  };
}

export async function controlServer(action: 'start' | 'stop' | 'restart'): Promise<void> {
  if (!testUnit() && intercepted('SYSTEMCTL', `${action} ${serverUnit()}`)) return;
  const { ok, out } = await run(['systemctl', '--user', action, serverUnit()]);
  if (!ok) throw new Error(`systemctl ${action} : ${out.trim()}`);
}

/** Dernières lignes du journal du service. */
export async function serverJournal(lines = 200): Promise<string> {
  const { out } = await run(['journalctl', '--user', '-u', serverUnit(), '-n', String(lines), '--no-pager', '-o', 'short-iso']);
  return out.trim();
}

// ------------------------------------------------------------------ adresses

export interface ServerAddress {
  readonly label: string;
  readonly url: string;
}

/** Le serveur écoute-t-il sur le réseau (0.0.0.0 / ::) ? Lu dans les sockets en écoute (ss). */
export async function listeningOnNetwork(port: number): Promise<boolean> {
  const { ok, out } = await run(['ss', '-Hltn', `sport = :${port}`]);
  return ok && out.split('\n').some((l) => /\s(0\.0\.0\.0|\*|\[::\]):\d+\s/u.test(l));
}

/** Port du serveur, lu dans la ligne de commande de l'unité (sinon 4096). */
export const portOf = (command: string): number => Number(/--port[= ](\d+)/u.exec(command)?.[1] ?? DEFAULT_PORT);

const Interfaces = z.array(z.looseObject({ ifname: z.string(), addr_info: z.array(z.looseObject({ local: z.string() })) }));

/** Adresses où le serveur est joignable depuis un autre appareil : réseau local, Tailscale. */
export async function networkAddresses(port: number): Promise<ServerAddress[]> {
  const out: ServerAddress[] = [];
  const { ok, out: json } = await run(['ip', '-j', '-4', 'addr', 'show', 'scope', 'global']);
  if (!ok) return out;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(json);
  } catch {
    return out;
  }
  const ifaces = z.safeParse(Interfaces, parsed);
  if (!ifaces.success) return out;
  for (const i of ifaces.data) {
    // conteneurs et ponts virtuels : inutiles pour un téléphone
    if (/^(docker|br-|veth|virbr|podman|lxc)/u.test(i.ifname)) continue;
    for (const a of i.addr_info) {
      const tailscale = i.ifname.startsWith('tailscale') || a.local.startsWith('100.');
      out.push({ label: tailscale ? `Tailscale (${i.ifname})` : `Réseau local (${i.ifname})`, url: `http://${a.local}:${port}` });
    }
  }
  return out;
}
