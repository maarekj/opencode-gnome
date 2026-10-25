"""Menu Aide : guide d'utilisation (F1), raccourcis clavier (Ctrl+?), à propos."""

from conftest import scenario


def open_menu_item(app, label):
    app.click('toggle button', contains='Menu principal')
    app.find('menu item', label).doActionNamed('click')


def test_guide_par_le_menu(run_app):
    _, app = run_app(scenario('composer'))
    open_menu_item(app, "Guide d'utilisation")
    app.find('frame', "Guide d'utilisation")
    assert app.text_visible('serveur partagé')


def test_guide_par_f1_et_fermeture_par_echap(run_app):
    _, app = run_app(scenario('composer'))
    app.key('F1')
    app.find('frame', "Guide d'utilisation")
    app.key('Escape')
    assert not app.has('frame', "Guide d'utilisation")


def test_raccourcis_par_le_menu(run_app):
    _, app = run_app(scenario('composer'))
    open_menu_item(app, 'Raccourcis clavier')
    app.find('dialog', 'Raccourcis clavier')
    assert app.text_visible('Afficher / masquer les terminaux')


def test_raccourcis_par_ctrl_point_d_interrogation(run_app):
    _, app = run_app(scenario('composer'))
    app.key('<Control>question')
    app.find('dialog', 'Raccourcis clavier')


def test_a_propos(run_app):
    _, app = run_app(scenario('composer'))
    open_menu_item(app, 'À propos')
    dialog = app.dialog()
    assert app.text_visible('opencode-gnome')
    # version du serveur (faux opencode : « fake ») dans les détails
    app.click(None, 'Détails', within=dialog)
    assert app.text_visible('opencode fake')
