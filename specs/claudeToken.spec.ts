// Renouvellement du jeton Claude (#167).
import { decide, FAILURE_PAUSE_MS, REFRESH_BEFORE_MS } from '../src/shared/claudeToken.ts';

describe('decide', () => {
  const now = 1_000_000_000;
  it('pas de compte, jeton valable, à renouveler', () => {
    expect(decide(null, {}, now)).toBe('none');
    expect(decide(now + REFRESH_BEFORE_MS + 1, {}, now)).toBe('valid');
    expect(decide(now + REFRESH_BEFORE_MS - 1, {}, now)).toBe('refresh');
    expect(decide(now - 3_600_000, {}, now)).toBe('refresh');
  });
  it('pause après un échec, puis nouvel essai', () => {
    const failed = { failures: 1, lastAttempt: now - 60_000, lastError: 'x' };
    expect(decide(now - 1, failed, now)).toBe('paused');
    expect(decide(now - 1, { ...failed, lastAttempt: now - FAILURE_PAUSE_MS - 1 }, now)).toBe('refresh');
    // un succès remet le compteur à zéro
    expect(decide(now - 1, { lastAttempt: now - 1000, lastSuccess: now - 1000 }, now)).toBe('refresh');
  });
});
