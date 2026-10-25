// Liens épinglés : variables ($VAR, ${VAR}), adresse complétée, recherche du .envrc.
import GLib from 'gi://GLib';
import { findEnvrc, substitute, variablesOf, withScheme } from '../src/shared/direnv.ts';

describe('variablesOf', () => {
  it('trouve $VAR et ${VAR}', () => {
    expect(variablesOf('http://$HOST:${PORT_WEB}/x')).toEqual(['HOST', 'PORT_WEB']);
    expect(variablesOf('https://opencode.ai')).toEqual([]);
  });
});

describe('substitute', () => {
  it('remplace par les variables du dossier, puis de l’environnement', () => {
    expect(substitute('localhost:$PORT_WEB/admin', { PORT_WEB: '3001' }, '/p')).toBe('localhost:3001/admin');
    expect(substitute('${HOME}/x', {}, '/p')).toBe(`${GLib.get_home_dir()}/x`);
  });
  it('signale les variables inconnues', () => {
    expect(() => substitute('$A:$B', { A: '1' }, '/p')).toThrowError(/inconnue dans \/p : B/u);
  });
});

describe('withScheme', () => {
  it('ajoute http:// aux adresses hôte:port', () => {
    expect(withScheme('localhost:3000')).toBe('http://localhost:3000');
    expect(withScheme('monhote:8080/x')).toBe('http://monhote:8080/x');
    expect(withScheme('127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(withScheme('api.local')).toBe('http://api.local');
  });
  it('garde les adresses avec schéma', () => {
    expect(withScheme('https://opencode.ai')).toBe('https://opencode.ai');
    expect(withScheme('mailto:a@b.c')).toBe('mailto:a@b.c');
  });
});

describe('findEnvrc', () => {
  it('remonte jusqu’au .envrc le plus proche', () => {
    const root = GLib.dir_make_tmp('direnv-XXXXXX');
    const sub = GLib.build_filenamev([root, 'a', 'b']);
    GLib.mkdir_with_parents(sub, 0o700);
    GLib.file_set_contents(GLib.build_filenamev([root, '.envrc']), 'export X=1\n');
    expect(findEnvrc(sub)).toBe(GLib.build_filenamev([root, '.envrc']));
  });
});
