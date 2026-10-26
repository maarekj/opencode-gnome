// Méthode de saisie (#138) : sous Wayland, GTK_IM_MODULE=ibus remplacé par le module wayland.
import { inputModuleOverride } from '../src/app/inputMethod.ts';

describe('méthode de saisie', () => {
  it('Wayland + ibus : module wayland', () => {
    expect(inputModuleOverride({ wayland: 'wayland-0', module: 'ibus' })).toBe('wayland');
  });

  it('X11 : environnement conservé', () => {
    expect(inputModuleOverride({ wayland: null, module: 'ibus' })).toBeNull();
  });

  it('autre module choisi : conservé', () => {
    expect(inputModuleOverride({ wayland: 'wayland-0', module: 'fcitx' })).toBeNull();
    expect(inputModuleOverride({ wayland: 'wayland-0', module: null })).toBeNull();
  });
});
