// `ocg claude` : jeton du compte Claude utilisé par opencode (plugin opencode-claude-auth, #167).
import GLib from 'gi://GLib';
import { readState, refreshToken, tokenStatus } from '../shared/claudeToken.ts';
import { parseArgs, UsageError } from './args.ts';
import { notify } from './notify.ts';

export const CLAUDE_HELP = `ocg claude — jeton du compte Claude (forfait) utilisé par opencode

Le plugin opencode-claude-auth reprend le jeton de Claude Code (~/.claude/.credentials.json)
mais ne le renouvelle pas toujours : « claude -p » le fait, à l'approche de l'expiration.
Un timer systemd utilisateur (opencode-gnome-claude-refresh.timer) lance « ocg claude refresh »
chaque minute : seule l'heure d'expiration est lue, claude n'est lancé qu'à moins de 2 min de
l'expiration (pause de 5 min après un échec, notification).

Usage :
  ocg claude status [--json]     expiration du jeton, dernier renouvellement, dernier échec
  ocg claude refresh [--force]   renouvelle si le jeton expire bientôt (--force : maintenant)
                     [--quiet]   rien affiché sans renouvellement (timer)`;

const time = (ms: number): string => GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000)).format('%d/%m %H:%M:%S') ?? '';

function delay(ms: number): string {
  const min = Math.round(Math.abs(ms) / 60_000);
  const text = min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
  return ms >= 0 ? `dans ${text}` : `depuis ${text}`;
}

export async function claudeCommand(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest, new Set(['force', 'quiet']));
  if (command === undefined || args.flags.has('help') || command === 'help') {
    print(CLAUDE_HELP);
    return 0;
  }
  switch (command) {
    case 'status': {
      const s = tokenStatus();
      if (args.flags.has('json')) {
        print(JSON.stringify({ ...s, state: readState() }));
        return 0;
      }
      if (s === null) {
        print('aucun compte Claude sur cette machine (lancer claude pour se connecter)');
        return 1;
      }
      print(`jeton : ${s.expired ? 'expiré' : 'valable'} (expiration ${time(s.expiresAt)}, ${delay(s.expiresAt - Date.now())})`);
      if (s.lastSuccess !== null) print(`dernier renouvellement : ${time(s.lastSuccess)}`);
      if (s.error !== null) print(`dernier échec : ${s.error}`);
      return s.expired ? 1 : 0;
    }
    case 'refresh': {
      const before = readState();
      const expiry = tokenStatus()?.expiresAt ?? null;
      const r = await refreshToken(args.flags.has('force'));
      const acted = r.decision === 'refresh' || r.decision === 'forced';
      if (acted && r.ok) {
        print(`${r.expiresAt === expiry ? 'jeton valable, inchangé' : 'jeton renouvelé'} : expiration ${r.expiresAt === null ? '?' : time(r.expiresAt)}`);
        // retour à la normale après un échec notifié : la notification d'échec est remplacée
        if ((before.failures ?? 0) > 0) notify({ id: 'claude-token', title: 'Connexion Claude rétablie', body: 'Les agents peuvent de nouveau utiliser le forfait.', urgent: false });
        return 0;
      }
      if (acted) {
        printerr(`renouvellement impossible : ${r.error ?? '?'}`);
        // une seule notification par série d'échecs (le timer réessaie toutes les 5 min)
        if ((before.failures ?? 0) === 0)
          notify({ id: 'claude-token', title: 'Connexion Claude expirée', body: `Les agents opencode ne peuvent plus utiliser le forfait : ${r.error ?? ''}. Lancer « claude » pour se reconnecter.`, urgent: true });
        return 1;
      }
      if (r.decision === 'none') {
        if (!args.flags.has('quiet')) printerr(r.error ?? 'pas de compte Claude');
        return args.flags.has('quiet') ? 0 : 1;
      }
      if (!args.flags.has('quiet')) {
        const msg = { valid: 'jeton valable, rien à faire', paused: 'échec récent : nouvel essai dans quelques minutes (--force pour réessayer)', busy: 'renouvellement déjà en cours' } as const;
        print(`${msg[r.decision]}${r.expiresAt === null ? '' : ` (expiration ${time(r.expiresAt)})`}`);
      }
      return 0;
    }
    default:
      throw new UsageError(`ocg claude ${command} : commande inconnue (ocg claude --help)`);
  }
}
