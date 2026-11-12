// Quotas du forfait Claude (Pro / Max) des agents (#166) : lus avec le jeton OAuth d'opencode
// (`~/.local/share/opencode/auth.json`, entrée `anthropic`, jamais modifié) sur les adresses
// utilisées par `/usage` de Claude Code. Adresses non documentées : toute réponse illisible
// masque l'indicateur au lieu d'afficher une erreur.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import * as z from 'zod/mini';
import { sandboxed } from './sandbox.ts';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const API = 'https://api.anthropic.com/api/oauth';
/** Intervalle minimal entre deux lectures. */
export const USAGE_INTERVAL_S = 60;

const Window = z.object({
  utilization: z.number(),
  resets_at: z.nullish(z.string()),
});
const UsageResponse = z.record(z.string(), z.unknown());
const Profile = z.object({
  account: z.optional(z.object({ email_address: z.nullish(z.string()), full_name: z.nullish(z.string()), display_name: z.nullish(z.string()) })),
  organization: z.optional(z.object({ name: z.nullish(z.string()), organization_type: z.nullish(z.string()) })),
});
const Auth = z.object({ anthropic: z.optional(z.object({ type: z.string(), access: z.optional(z.string()) })) });

/** Une limite : pourcentage consommé (0–100) et remise à zéro. */
export interface UsageLimit {
  readonly key: string;
  readonly label: string;
  readonly percent: number;
  readonly resetsAt: Date | null;
}

export interface Usage {
  /** limites présentes, fenêtre de 5 h d'abord */
  readonly limits: readonly UsageLimit[];
  /** compte : email (ou nom), forfait */
  readonly account: string | null;
  readonly plan: string | null;
  readonly fetchedAt: Date;
}

/** Limites affichées (les autres clés de la réponse sont des expériences internes). */
const LABELS: readonly (readonly [string, string])[] = [
  ['five_hour', '5 h'],
  ['seven_day', '7 jours'],
  ['seven_day_opus', '7 jours · Opus'],
  ['seven_day_sonnet', '7 jours · Sonnet'],
];

/** Réponse de `/usage` → limites connues et renseignées (null : réponse illisible). */
export function parseUsage(json: unknown): UsageLimit[] | null {
  const r = UsageResponse.safeParse(json);
  if (!r.success) return null;
  const out: UsageLimit[] = [];
  for (const [key, label] of LABELS) {
    const w = Window.safeParse(r.data[key]);
    if (!w.success) continue;
    const reset = w.data.resets_at === null || w.data.resets_at === undefined ? null : new Date(w.data.resets_at);
    // utilization : pourcentage (0–100) ; borné pour l'affichage
    out.push({ key, label, percent: Math.max(0, Math.min(100, w.data.utilization)), resetsAt: reset !== null && Number.isNaN(reset.getTime()) ? null : reset });
  }
  return out;
}

/** Réponse de `/profile` → compte affiché. L'email manque parfois : celui du nom d'organisation. */
export function parseProfile(json: unknown): { account: string | null; plan: string | null } {
  const r = Profile.safeParse(json);
  if (!r.success) return { account: null, plan: null };
  const { account, organization } = r.data;
  const fromOrg = /^(\S+@\S+)'s Organization$/u.exec(organization?.name ?? '')?.[1];
  const email = account?.email_address ?? fromOrg ?? null;
  const name = account?.full_name ?? account?.display_name ?? null;
  const type = organization?.organization_type ?? null;
  const plan = type === null ? null : (({ claude_max: 'Claude Max', claude_pro: 'Claude Pro', claude_team: 'Claude Team', claude_enterprise: 'Claude Enterprise' }) as Record<string, string>)[type] ?? type;
  return { account: email ?? name, plan };
}

/** « dans 25 min », « dans 2 h 05 », « le 19/11 à 01:00 » : délai avant la remise à zéro. */
export function resetText(at: Date | null, now = new Date()): string {
  if (at === null) return '';
  const min = Math.max(0, Math.round((at.getTime() - now.getTime()) / 60_000));
  if (min < 60) return `dans ${min} min`;
  if (min < 24 * 60) return `dans ${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
  const d = GLib.DateTime.new_from_unix_local(Math.floor(at.getTime() / 1000));
  return `le ${d.format('%d/%m à %H:%M') ?? ''}`;
}

/** Seuils notifiés, une fois par limite et par période. */
export const USAGE_ALERTS = [80, 95] as const;

/** Seuil franchi depuis la lecture précédente (null : aucun). */
export function crossedAlert(before: number | undefined, now: number): number | null {
  let hit: number | null = null;
  for (const t of USAGE_ALERTS) if (now >= t && (before === undefined || before < t)) hit = t;
  return hit;
}

/** Niveau d'alerte d'un pourcentage. */
export const usageLevel = (percent: number): 'ok' | 'warning' | 'critical' => (percent >= USAGE_ALERTS[1] ? 'critical' : percent >= USAGE_ALERTS[0] ? 'warning' : 'ok');

function readToken(): string | null {
  const path = GLib.build_filenamev([GLib.get_user_data_dir(), 'opencode', 'auth.json']);
  try {
    const [, bytes] = GLib.file_get_contents(path);
    const r = Auth.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    const a = r.success ? r.data.anthropic : undefined;
    return a?.type === 'oauth' && a.access !== undefined ? a.access : null;
  } catch {
    return null;
  }
}

/** profil du jeton courant (lu une fois par jeton, seulement s'il a réussi) */
let profileFor: { token: string; account: string | null; plan: string | null } | null = null;

const http = new Soup.Session({ timeout: 15 });

/** Jeton refusé (expiré, révoqué) : les quotas affichés ne sont plus fiables. */
export class UsageAuthError extends Error {}

async function getJson(path: string, token: string): Promise<unknown> {
  const msg = Soup.Message.new('GET', `${API}/${path}`);
  if (msg === null) throw new Error('URL invalide');
  const h = msg.get_request_headers();
  h.replace('Authorization', `Bearer ${token}`);
  h.replace('anthropic-beta', 'oauth-2025-04-20');
  h.replace('Accept', 'application/json');
  const bytes = await http.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
  const status: number = msg.get_status();
  if (status === 401 || status === 403) throw new UsageAuthError(`${path} : HTTP ${status}`);
  if (status < 200 || status >= 300) throw new Error(`${path} : HTTP ${status}`);
  const data = bytes.get_data();
  return JSON.parse(data === null ? '' : new TextDecoder().decode(data));
}

/**
 * Source des quotas. En bac à sable (captures, tests) : jamais de réseau ; seulement le fichier
 * `OPENCODE_GNOME_TEST_USAGE` (réponse de `/usage`, plus `profile` facultatif) s'il est donné.
 */
export async function loadUsage(): Promise<Usage | null> {
  const fake = GLib.getenv('OPENCODE_GNOME_TEST_USAGE');
  if (fake !== null) {
    const [, bytes] = GLib.file_get_contents(fake);
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const limits = parseUsage(json);
    const r = UsageResponse.safeParse(json);
    return limits === null ? null : { limits, ...parseProfile(r.success ? r.data['profile'] : null), fetchedAt: new Date() };
  }
  if (sandboxed()) return null;
  const token = readToken();
  if (token === null) return null;
  const limits = parseUsage(await getJson('usage', token));
  if (limits === null) return null;
  // profil : une seule fois (le compte ne change qu'à une reconnexion, d'où un nouveau jeton)
  if (profileFor?.token !== token) {
    try {
      profileFor = { token, ...parseProfile(await getJson('profile', token)) };
    } catch {
      // réessayé à la lecture suivante
    }
  }
  const profile = profileFor?.token === token ? profileFor : null;
  return { limits, account: profile?.account ?? null, plan: profile?.plan ?? null, fetchedAt: new Date() };
}

