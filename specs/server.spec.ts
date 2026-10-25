// Réglages d'accès du serveur partagé (server.env).
import GLib from 'gi://GLib';
import { readServerAccess, writeServerAccess } from '../src/shared/server.ts';

const path = (): string => GLib.build_filenamev([GLib.dir_make_tmp('srv-XXXXXX'), 'server.env']);

describe('server.env', () => {
  it('absent : accès local sans mot de passe', () => {
    expect(readServerAccess('/nonexistent/server.env')).toEqual({ network: false, password: '' });
  });
  it('écrit puis relit accès réseau et mot de passe', () => {
    const p = path();
    writeServerAccess({ network: true, password: 'Abc-123!x' }, p);
    expect(readServerAccess(p)).toEqual({ network: true, password: 'Abc-123!x' });
    writeServerAccess({ network: false, password: '' }, p);
    expect(readServerAccess(p)).toEqual({ network: false, password: '' });
  });
  it('refuse les caractères dangereux', () => {
    expect(() => writeServerAccess({ network: true, password: 'a b' }, path())).toThrowError(/interdits/u);
    expect(() => writeServerAccess({ network: true, password: 'a"$' }, path())).toThrowError(/interdits/u);
  });
});
