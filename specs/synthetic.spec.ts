// Entrées synthetic d'OpenCode 2 affichées : sous-agents et commandes en arrière-plan (#179).
import { syntheticItem } from '../src/shared/v2/synthetic.ts';

const time = { created: 1000 };

describe('syntheticItem', () => {
  it('sous-agent : appel d\'outil subagent terminé, session et rapport', () => {
    const item = syntheticItem({
      id: 'msg_1',
      time,
      description: 'relecture',
      metadata: { source: 'subagent', childID: 'ses_c', agent: 'build', state: 'completed' },
      text: '<subagent sessionID="ses_c" state="completed" description="relecture">\nRien à relire.\n\n- point\n</subagent>',
    });
    expect(item?.kind).toBe('tool');
    if (item?.kind !== 'tool') return;
    expect(item.tool.name).toBe('subagent');
    expect(item.tool.status).toBe('completed');
    expect(item.tool.metadata['sessionID']).toBe('ses_c');
    expect(item.tool.input).toEqual({ description: 'relecture', agent: 'build' });
    expect(item.tool.output).toBe('Rien à relire.\n\n- point');
  });

  it('sous-agent en échec : erreur', () => {
    const item = syntheticItem({ id: 'm', time, metadata: { source: 'subagent', childID: 'c', state: 'failed' }, text: '<subagent sessionID="c" state="failed" description="x">\nPlantage\n</subagent>' });
    expect(item?.kind === 'tool' ? [item.tool.status, item.tool.error, item.tool.input['description']] : null).toEqual(['error', 'Plantage', 'x']);
  });

  it('commande en arrière-plan : commande (guillemets non échappés), sortie et code de sortie', () => {
    const item = syntheticItem({
      id: 'm',
      time,
      metadata: { source: 'shell', shellID: 'sh_1', state: 'completed', exit: 1 },
      text: '<shell id="sh_1" state="completed" command="grep -n "a(" f.py; echo fin">\nligne 1\nligne 2\n\n</shell>',
    });
    expect(item).toEqual({ kind: 'shell', id: 'm:shell', messageID: 'm', command: 'grep -n "a(" f.py; echo fin', status: 'completed', output: 'ligne 1\nligne 2', exit: 1 });
  });

  it('sous-agent annulé : message en français', () => {
    const item = syntheticItem({ id: 'm', time, metadata: { source: 'subagent', childID: 'c', state: 'cancelled' }, text: '<subagent sessionID="c" state="cancelled" description="x">\nSubagent cancelled\n</subagent>' });
    expect(item?.kind === 'tool' ? item.tool.error : null).toBe('Sous-agent annulé');
  });

  it('autres entrées (relances, fichiers joints) : masquées', () => {
    expect(syntheticItem({ id: 'm', time, text: 'Summarize the task tool output above and continue with your task.' })).toBeNull();
  });
});
