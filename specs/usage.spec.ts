// Quotas du forfait Claude (#166).
import { crossedAlert, parseProfile, parseUsage, resetText, usageLevel } from '../src/shared/usage.ts';

describe('parseUsage', () => {
  it('garde les limites connues et renseignées, dans l’ordre', () => {
    const limits = parseUsage({
      five_hour: null,
      seven_day: { utilization: 42.5, resets_at: '2026-11-19T00:00:00.271609+00:00' },
      seven_day_opus: { utilization: 130, resets_at: null },
      iguana_necktie: { utilization: 3 },
    });
    expect(limits?.map((l) => [l.key, l.percent])).toEqual([
      ['seven_day', 42.5],
      ['seven_day_opus', 100],
    ]);
    expect(limits?.[0]?.resetsAt?.toISOString()).toBe('2026-11-19T00:00:00.271Z');
    expect(limits?.[1]?.resetsAt).toBeNull();
  });

  it('réponse illisible : null', () => {
    expect(parseUsage('erreur')).toBeNull();
    expect(parseUsage({ seven_day: { utilization: 'x' } })).toEqual([]);
  });
});

describe('parseProfile', () => {
  it('email absent : celui du nom d’organisation', () => {
    expect(parseProfile({ account: { email_address: null, full_name: 'Michael' }, organization: { name: "m@x.com's Organization", organization_type: 'claude_max' } })).toEqual({ account: 'm@x.com', plan: 'Claude Max' });
  });
  it('profil illisible', () => {
    expect(parseProfile(null)).toEqual({ account: null, plan: null });
  });
});

describe('affichage', () => {
  const now = new Date('2026-11-12T10:00:00Z');
  it('délai de remise à zéro', () => {
    expect(resetText(new Date('2026-11-12T10:25:00Z'), now)).toBe('dans 25 min');
    expect(resetText(new Date('2026-11-12T12:05:00Z'), now)).toBe('dans 2 h 05');
    expect(resetText(null, now)).toBe('');
  });
  it('niveaux et seuils', () => {
    expect([usageLevel(10), usageLevel(80), usageLevel(95), usageLevel(79)]).toEqual(['ok', 'warning', 'critical', 'ok']);
    expect(crossedAlert(70, 85)).toBe(80);
    expect(crossedAlert(70, 96)).toBe(95);
    expect(crossedAlert(85, 90)).toBeNull();
  });
});
