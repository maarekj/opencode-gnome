// En tête de la barre latérale : sessions groupées par état (#178).
import { groupOf, stateEntries } from '../src/shared/stategroups.ts';
import type { Session } from '../src/shared/schemas.ts';
import type { Activity, ProjectView, SessionView } from '../src/shared/store.ts';

const view = (id: string, activity: Activity, created = 0): SessionView => {
  const session: Session = { id, title: id, projectID: 'p', directory: '/p', cost: 0, time: { created, updated: created } };
  return { session, activity, unread: false };
};

const project = (name: string, sessions: SessionView[]): ProjectView => ({ key: name, name, path: `/p/${name}`, vcs: true, sessions, working: 0, waiting: 0, unread: 0, updated: 0 });

describe('groupOf', () => {
  it('demandes en attente : action requise, même fermée', () => {
    expect(groupOf(view('a', 'permission'), false, false)).toBe('action');
    expect(groupOf(view('a', 'question'), true, true)).toBe('action');
  });

  it('agent au travail : en cours, même fermée', () => {
    expect(groupOf(view('a', 'busy'), false, true)).toBe('working');
    expect(groupOf(view('a', 'retry'), true, false)).toBe('working');
  });

  it('inactive : à lire si ouverte et pas mise de côté, absente sinon', () => {
    expect(groupOf(view('a', 'idle'), true, true)).toBe('toread');
    expect(groupOf(view('a', 'idle'), true, false)).toBeNull();
    expect(groupOf(view('a', 'idle'), false, true)).toBeNull();
  });
});

describe('stateEntries', () => {
  it('ordre des groupes, puis ordre des sessions ouvertes, puis plus récentes', () => {
    const p1 = project('p1', [view('idle-open', 'idle'), view('busy-closed-old', 'busy', 1), view('perm', 'permission'), view('closed', 'idle')]);
    const p2 = project('p2', [view('busy-open', 'busy'), view('busy-closed-new', 'busy', 2), view('read', 'idle')]);
    const e = stateEntries([p1, p2], ['read', 'busy-open', 'idle-open'], ['read']);
    expect(e.map((x) => `${x.group}:${x.view.session.id}`)).toEqual(['action:perm', 'toread:read', 'working:busy-open', 'working:busy-closed-new', 'working:busy-closed-old']);
    expect(e.find((x) => x.view.session.id === 'read')?.project.name).toBe('p2');
  });
});
