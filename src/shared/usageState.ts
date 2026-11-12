// État partagé des quotas du forfait Claude (#166), séparé de `usage.ts` (sans gnim, testé seul).
import GLib from 'gi://GLib';
import { createState, type Accessor } from 'gnim';
import { refreshToken, tokenStatus, type TokenStatus } from './claudeToken.ts';
import { errorMessage } from './errors.ts';
import { intercepted, sandboxed } from './sandbox.ts';
import { loadUsage, UsageAuthError, USAGE_INTERVAL_S, type Usage } from './usage.ts';

const [usage, setUsage] = createState<Usage | null>(null);
let last = 0;
let pending: Promise<void> | null = null;

const [token, setToken] = createState<TokenStatus | null>(null);
/** Jeton du compte Claude (#167) ; null : pas de compte. Bac à sable : seulement avec CLAUDE_CONFIG_DIR. */
export const claudeToken: Accessor<TokenStatus | null> = token;
const readToken = (): void => setToken(sandboxed() && GLib.getenv('CLAUDE_CONFIG_DIR') === null ? null : tokenStatus());

const [renewing, setRenewing] = createState(false);
export const claudeRenewing: Accessor<boolean> = renewing;

/** Bouton « Renouveler » : `claude -p` maintenant (même verrou que le timer), puis relecture. */
export async function renewClaudeToken(): Promise<void> {
  if (renewing.peek() || intercepted('CLAUDE', 'refresh --force')) return;
  setRenewing(true);
  try {
    await refreshToken(true);
  } finally {
    setRenewing(false);
    readToken();
    await refreshUsage(true);
  }
}

/** Quotas courants (null : pas de forfait Claude connecté, ou réponse illisible). */
export const claudeUsage: Accessor<Usage | null> = usage;

/**
 * Relit les quotas si la dernière lecture date de plus d'une minute (`force` : sans attendre).
 * Erreur réseau : la dernière valeur reste affichée (jeton refusé : masquée).
 */
export function refreshUsage(force = false): Promise<void> {
  const now = GLib.get_monotonic_time() / 1e6;
  if (pending !== null) return pending;
  if (!force && last !== 0 && now - last < USAGE_INTERVAL_S) return Promise.resolve();
  last = now;
  readToken();
  pending = loadUsage()
    .then((u) => setUsage(u))
    .catch((e: unknown) => {
      // jeton refusé : barre masquée plutôt qu'un pourcentage périmé
      if (e instanceof UsageAuthError) setUsage(null);
      console.warn(`quotas Claude : ${errorMessage(e)}`);
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
