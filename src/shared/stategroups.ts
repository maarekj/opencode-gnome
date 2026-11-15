// En tête de la barre latérale (#178) : sessions qui demandent une action, réponses à lire, en cours.
import type { ProjectView, SessionView } from './store.ts';

export type StateGroup = 'action' | 'toread' | 'working';

export const GROUP_ORDER: readonly StateGroup[] = ['action', 'toread', 'working'];

export const GROUP_TITLES: Readonly<Record<StateGroup, string>> = {
  action: 'Action requise',
  toread: 'Réponse à lire',
  working: 'En cours',
};

export interface StateEntry {
  readonly group: StateGroup;
  readonly view: SessionView;
  readonly project: ProjectView;
  readonly open: boolean;
}

/** Groupe d'une session ; null : inactive et sans réponse à lire, absente de l'en-tête. */
export function groupOf(view: SessionView, open: boolean, toRead: boolean): StateGroup | null {
  if (view.activity === 'question' || view.activity === 'permission') return 'action';
  if (view.activity === 'busy' || view.activity === 'retry') return 'working';
  return open && toRead ? 'toread' : null;
}

/**
 * Sessions de l'en-tête, dans l'ordre des groupes. Dans un groupe : ordre des sessions ouvertes
 * (stable, pas de saut sous la souris), puis les sessions actives non ouvertes, plus récentes d'abord.
 */
export function stateEntries(projects: readonly ProjectView[], openSessions: readonly string[], toRead: readonly string[]): StateEntry[] {
  const openRank = new Map(openSessions.map((id, i) => [id, i]));
  const reads = new Set(toRead);
  const entries: StateEntry[] = [];
  for (const project of projects)
    for (const view of project.sessions) {
      const open = openRank.has(view.session.id);
      const group = groupOf(view, open, reads.has(view.session.id));
      if (group !== null) entries.push({ group, view, project, open });
    }
  const rank = (e: StateEntry): number => openRank.get(e.view.session.id) ?? Number.MAX_SAFE_INTEGER;
  const created = (e: StateEntry): number => e.view.session.time.created;
  return entries.toSorted((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || rank(a) - rank(b) || created(b) - created(a));
}
