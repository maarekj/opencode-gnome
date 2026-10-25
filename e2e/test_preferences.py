"""Préférences : apparence, notifications, terminal, modèle par défaut, rendu des messages."""

from conftest import scenario, wait_until


def open_prefs(run_app, **kw):
    fake, app = run_app(scenario('composer'), **kw)
    app.key('<Control>comma')
    dialog = app.find('dialog', 'Préférences')
    return fake, app, dialog


def saved(app, key, value):
    wait_until(lambda: app.settings().get(key) == value, 5, f'réglage {key} = {value!r}')


def test_ouverture_par_le_menu(run_app):
    _, app = run_app(scenario('composer'))
    app.click('toggle button', 'Menu principal')
    app.find('menu item', 'Préférences').doActionNamed('click')
    app.find('dialog', 'Préférences')


def test_theme_de_l_application(run_app):
    _, app, dialog = open_prefs(run_app)
    app.combo('Application', 'Nuit', within=dialog)
    saved(app, 'appTheme', 'dark')


def test_notifications_et_son(run_app):
    _, app, _ = open_prefs(run_app)
    # le son dépend des notifications : coupé d'abord
    app.toggle('switch', 'Son')
    saved(app, 'notificationSound', False)
    app.toggle('switch', 'Notifications')
    saved(app, 'notifications', False)


def test_terminal_integre(run_app):
    _, app, _ = open_prefs(run_app)
    app.toggle('switch', 'Terminal intégré')
    saved(app, 'terminalIntegrated', False)


def test_modele_par_defaut_preselectionne(run_app):
    fake, app, dialog = open_prefs(run_app)
    # liste chargée depuis le serveur : la ligne devient active une fois remplie
    wait_until(lambda: app.find('combo box', 'Modèle', within=dialog).getState().contains(__import__('conftest').Atspi.StateType.SENSITIVE), 5, 'modèles chargés')
    app.combo('Modèle', 'fake/other-model', within=dialog)
    saved(app, 'defaultModel', 'fake/other-model')
    app.click('button', 'Close', within=dialog)
    # nouvelle session (sans modèle) : le modèle par défaut est présélectionné
    app.click('list item', 'demo')
    app.click('button', 'Nouvelle session')
    app.find('toggle button', 'fake/other-model')


def test_rendu_des_messages(run_app):
    _, app, dialog = open_prefs(run_app)
    app.click('page tab', 'Rendu des messages')
    app.toggle('switch', 'Toute la largeur')
    saved(app, 'maxWidth', 0)
    app.combo('Police', 'Chasse fixe', within=dialog)
    wait_until(lambda: app.settings().get('markdown', {}).get('font') == 'mono', 5, 'police enregistrée')
    app.click('button', 'Valeurs par défaut', within=dialog)
    wait_until(lambda: app.settings().get('markdown', {}).get('font', 'system') == 'system', 5, 'valeurs par défaut rétablies')
