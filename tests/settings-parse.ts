// Non-régression #64 : un champ invalide de settings.json ne remet pas les autres à zéro.
import { parseSettings } from '../src/shared/settings.ts';

const s = parseSettings({ favorites: ['/a', '/b'], fontScale: 'grand', sidebarMode: 'inconnu', openSessions: ['ses_1'] });
const ok = s.favorites.length === 2 && s.openSessions[0] === 'ses_1' && s.fontScale === 100 && s.sidebarMode === 'all';
print(ok ? 'TEST OK' : `réglages perdus : ${JSON.stringify(s)}`);
