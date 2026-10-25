// Horaires des tâches : conversion cron → OnCalendar, description lisible.
import { cronToCalendar, describeSchedule, isManual } from '../src/shared/tasks.ts';

describe('cronToCalendar', () => {
  // forme brute (non complétée de zéros) : systemd la normalise ensuite (parseSchedule)
  it('convertit une expression cron simple', () => {
    expect(cronToCalendar('0 9 * * *')).toBe('*-*-* 9:0:00');
    expect(cronToCalendar('30 8 * * 1-5')).toBe('Mon..Fri *-*-* 8:30:00');
  });

  it('gère pas et jour du mois', () => {
    expect(cronToCalendar('*/15 * * * *')).toBe('*-*-* *:0/15:00');
    expect(cronToCalendar('0 9 1 * *')).toBe('*-*-1 9:0:00');
  });

  it("renvoie null si ce n'est pas du cron", () => {
    expect(cronToCalendar('Mon..Fri 09:00')).toBeNull();
    expect(cronToCalendar('daily')).toBeNull();
  });

  it('refuse jour du mois et jour de la semaine ensemble', () => {
    expect(() => cronToCalendar('0 9 1 * 1')).toThrowError(/jour du mois et jour de la semaine/u);
  });
});

describe('describeSchedule', () => {
  it('décrit les horaires courants en français', () => {
    expect(describeSchedule('*-*-* 09:00:00')).toBe('tous les jours à 09:00');
    expect(describeSchedule('Mon..Fri *-*-* 09:00:00')).toBe('en semaine à 09:00');
    expect(describeSchedule('Mon *-*-* 09:00:00')).toBe('le lundi à 09:00');
    expect(describeSchedule('*-*-* *:00:00')).toBe('toutes les heures');
    expect(describeSchedule('*-*-* *:00/15:00')).toBe('toutes les 15 min');
  });

  it("rend l'expression telle quelle si elle n'est pas reconnue", () => {
    expect(describeSchedule('*-*-01 09:00:00')).toBe('*-*-01 09:00:00');
  });

  it('tâche manuelle : « à la main »', () => {
    expect(describeSchedule('')).toBe('à la main');
    expect(isManual({ schedule: '' })).toBeTrue();
    expect(isManual({ schedule: 'daily' })).toBeFalse();
  });
});
