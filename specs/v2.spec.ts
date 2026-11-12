// Client OpenCode 2 : réponses réelles d'un serveur v2.2.7 (#169), relues par nos schémas.
import * as z from 'zod/mini';
import info from './fixtures/v2/info.json' with { type: 'json' };
import messages from './fixtures/v2/messages.json' with { type: 'json' };
import projects from './fixtures/v2/projects.json' with { type: 'json' };
import sessions from './fixtures/v2/sessions.json' with { type: 'json' };
import { Info, Messages, Project, SessionPage } from '../src/shared/v2/schemas.ts';

describe('schémas v2', () => {
  it('info et projets', () => {
    expect(z.parse(Info, info).version).toBe('2.2.7');
    const p = z.parse(z.array(Project), projects);
    expect(p.map((x) => x.canonical)).toContain('/tmp/opencode/v2/proj');
  });

  it('sessions : page et curseur', () => {
    const page = z.parse(SessionPage, sessions);
    expect(page.data[0]?.title).toBe('Essai v2');
    expect(page.data[0]?.location.directory).toBe('/tmp/opencode/v2/proj');
    expect(typeof page.cursor.next).toBe('string');
  });

  it('messages : types et champs non décrits conservés', () => {
    const page = z.parse(Messages, messages);
    expect([...new Set(page.data.map((m) => m.type))].toSorted()).toEqual(['assistant', 'idle', 'user']);
    const assistant = page.data.find((m) => m.type === 'assistant');
    expect(Array.isArray(assistant?.['content'])).toBeTrue();
  });
});
