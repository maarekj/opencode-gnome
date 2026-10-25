// Issues GitHub du dépôt d'un dossier, via la CLI `gh` (son authentification), en lecture seule.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as z from 'zod/mini';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

const Person = z.looseObject({ login: z.string() });
const Label = z.looseObject({ name: z.string(), color: z.optional(z.string()) });

export const IssueSummary = z.looseObject({
  number: z.number(),
  title: z.string(),
  state: z.string(), // OPEN | CLOSED
  author: z.nullable(Person),
  labels: z.array(Label),
  createdAt: z.string(),
  updatedAt: z.string(),
  comments: z.array(z.unknown()),
});
export type IssueSummary = z.output<typeof IssueSummary>;

export const IssueComment = z.looseObject({ author: z.nullable(Person), createdAt: z.string(), body: z.string() });
export type IssueComment = z.output<typeof IssueComment>;

export const IssueDetail = z.looseObject({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  stateReason: z.optional(z.nullable(z.string())),
  author: z.nullable(Person),
  labels: z.array(Label),
  assignees: z.array(Person),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.optional(z.nullable(z.string())),
  body: z.string(),
  url: z.string(),
  comments: z.array(IssueComment),
});
export type IssueDetail = z.output<typeof IssueDetail>;

export type IssueState = 'open' | 'closed' | 'all';

/** Erreur lisible (gh absent, pas de dépôt GitHub, non connecté…). */
export class GithubError extends Error {}

async function gh(directory: string, args: readonly string[]): Promise<unknown> {
  if (GLib.find_program_in_path('gh') === null) throw new GithubError('La commande gh (GitHub CLI) est introuvable.');
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE });
  launcher.set_cwd(directory);
  // sortie stable, sans couleurs ni invite interactive
  launcher.setenv('GH_PROMPT_DISABLED', '1', true);
  launcher.setenv('NO_COLOR', '1', true);
  const proc = launcher.spawnv(['gh', ...args]);
  const [out, err] = await proc.communicate_utf8_async(null, null);
  if (!proc.get_successful()) {
    const msg = (err ?? '').trim();
    if (/not a git repository|no git remotes|none of the git remotes/iu.test(msg)) throw new GithubError('Ce dépôt n’a pas de dépôt distant GitHub.');
    if (/gh auth login|authentication|not logged/iu.test(msg)) throw new GithubError('gh n’est pas connecté à GitHub (gh auth login).');
    if (/issues are disabled|has disabled issues/iu.test(msg)) throw new GithubError('Les issues sont désactivées sur ce dépôt.');
    throw new GithubError(msg.split('\n').at(-1) ?? 'gh a échoué');
  }
  return JSON.parse(out ?? 'null');
}

export async function listIssues(directory: string, state: IssueState, search = '', limit = 200): Promise<IssueSummary[]> {
  const args = ['issue', 'list', '--state', state, '--limit', String(limit), '--json', 'number,title,state,author,labels,createdAt,updatedAt,comments'];
  if (search.trim() !== '') args.push('--search', search.trim());
  return z.parse(z.array(IssueSummary), await gh(directory, args));
}

export async function issueDetail(directory: string, n: number): Promise<IssueDetail> {
  const fields = 'number,title,state,stateReason,author,labels,assignees,createdAt,updatedAt,closedAt,body,url,comments';
  return z.parse(IssueDetail, await gh(directory, ['issue', 'view', String(n), '--json', fields]));
}
