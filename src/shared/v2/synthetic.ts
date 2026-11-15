// Entrées `synthetic` d'OpenCode 2 affichées dans la conversation (#179). Sans dépendance GTK :
// testable seule (specs/synthetic.spec.ts).
import type { Item, ToolCall } from '../conversation.ts';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** En-tête `<balise attr="…">` et corps d'un texte `<balise …>\ncorps\n</balise>`. */
function tagged(text: string, tag: string): { head: string; body: string } {
  const end = text.indexOf('">\n');
  if (end < 0) return { head: '', body: text.trim() };
  const body = text.slice(end + 3).replace(new RegExp(`\\n?</${tag}>\\s*$`, 'u'), '');
  return { head: text.slice(0, end + 1), body: body.trim() };
}

/**
 * Entrée `synthetic` affichée (#179) : un sous-agent (carte de sous-agent, comme l'outil
 * `subagent`) ou une commande en arrière-plan (bloc shell) ; null pour les autres (masquées).
 */
export function syntheticItem(e: { readonly id: string; readonly time: { readonly created: number }; readonly text: string; readonly description?: string | undefined; readonly metadata?: Readonly<Record<string, unknown>> | undefined }): Item | null {
  const meta = e.metadata ?? {};
  const state = str(meta['state']) ?? 'completed';
  if (meta['source'] === 'subagent') {
    const childID = str(meta['childID']);
    const { head, body } = tagged(e.text, 'subagent');
    const description = e.description ?? /description="([^"]*)"/u.exec(head)?.[1] ?? '';
    const ok = state === 'completed';
    const tool: ToolCall = {
      callID: `synthetic:${e.id}`,
      name: 'subagent',
      status: ok ? 'completed' : 'error',
      input: { description, ...(str(meta['agent']) === undefined ? {} : { agent: str(meta['agent']) }) },
      output: ok ? body : '',
      // états v2 : completed, error, cancelled (jamais d'entrée en cours)
      ...(ok ? {} : { error: state === 'cancelled' ? 'Sous-agent annulé' : body === '' ? 'Sous-agent en échec' : body }),
      metadata: childID === undefined ? {} : { sessionID: childID },
      time: { start: e.time.created },
    };
    return { kind: 'tool', id: `${e.id}:subagent`, messageID: e.id, tool };
  }
  if (meta['source'] === 'shell') {
    // commande : dernier attribut de l'en-tête (guillemets non échappés : jusqu'au guillemet final)
    const { head, body } = tagged(e.text, 'shell');
    const command = /command="([\s\S]*)"$/u.exec(head)?.[1] ?? '';
    const exit = meta['exit'];
    return { kind: 'shell', id: `${e.id}:shell`, messageID: e.id, command, status: state, output: body, ...(typeof exit === 'number' || typeof exit === 'string' ? { exit } : {}) };
  }
  return null;
}
