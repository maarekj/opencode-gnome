"""Page d'un projet : liste des sessions, recherche, création, suppression, en-tête."""

import time

from conftest import scenario, wait_until

ALPHA = '/tmp/opencode-fake/alpha'


def open_project(app, name: str) -> None:
    app.click('list item', name)
    app.find('button', 'Nouvelle session')


def test_liste_des_sessions_avec_details(run_app):
    _, app = run_app(scenario('projects'))
    open_project(app, 'alpha')
    app.find('list item', "Refonte de l'API")
    app.find('list item', 'Corriger les tests')
    assert app.text_visible('plan')


def test_nouvelle_session_depuis_l_en_tete(run_app):
    fake, app = run_app(scenario('projects'))
    open_project(app, 'alpha')
    app.click('button', 'Nouvelle session')
    req = fake.wait_request('POST', '/session')
    assert req['query']['directory'] == ALPHA
    app.composer()


def test_projet_sans_session(run_app):
    data = scenario('projects')
    data['sessions'] = [s for s in data['sessions'] if s['id'] != 'ses_b1']
    data['projects'][1]['worktree'] = '/tmp/opencode-fake/beta'
    data['sessions'].append({'id': 'ses_tmp', 'projectID': 'prj_beta', 'directory': '/tmp/opencode-fake/beta', 'title': 'Temporaire', 'time': {'created': 1, 'updated': 1}})
    fake, app = run_app(data)
    open_project(app, 'béta-projet')
    # suppression de la seule session : page « Aucune session »
    app.click('button', 'Supprimer')
    app.click('button', 'Supprimer ?')
    fake.wait_request('DELETE', '/session/ses_tmp')
    assert app.text_visible('Aucune session')


def test_recherche_de_session(run_app):
    _, app = run_app(scenario('projects'))
    open_project(app, 'alpha')
    app.key('<Control>f')
    app.type('tests')
    wait_until(lambda: not app.has('list item', "Refonte de l'API"), 5, 'session filtrée')
    app.key('Return')
    # Entrée : la session trouvée s'ouvre
    app.composer()


def test_recherche_de_session_sans_resultat(run_app):
    _, app = run_app(scenario('projects'))
    open_project(app, 'alpha')
    app.key('<Control>f')
    app.type('introuvable')
    assert app.text_visible('Aucune session ne correspond à la recherche.')


def test_corbeille_se_desarme_sans_second_clic(run_app):
    fake, app = run_app(scenario('projects'))
    open_project(app, 'alpha')
    app.all('button', 'Supprimer')[0].doActionNamed('click')
    app.find('button', 'Supprimer ?')
    # sans second clic, le bouton redevient une corbeille au bout de 4 s
    wait_until(lambda: not app.has('button', 'Supprimer ?'), 7, 'corbeille réarmée')
    assert not fake.requests('DELETE')


def test_menu_session_ouvrir(run_app):
    fake, app = run_app(scenario('projects'))
    open_project(app, 'alpha')
    app.menu(app.find('list item', "Refonte de l'API"), 'Ouvrir')
    assert app.text_visible("Refais l'API REST.")


def test_bouton_git_selon_le_depot(run_app):
    _, app = run_app(scenario('projects'))
    open_project(app, 'alpha')
    assert app.has('button', 'Git : modifications, journal, branches, comparaison')
    open_project(app, 'béta-projet')
    wait_until(lambda: not app.has('button', 'Git : modifications, journal, branches, comparaison'), 5, 'pas de bouton git hors dépôt')


def test_ouvrir_le_dossier(run_app):
    _, app = run_app(scenario('projects'))
    open_project(app, 'alpha')
    app.click('button', 'Ouvrir le dossier')
    assert app.logged('DOSSIER', ALPHA)


def test_mcp_du_projet(run_app):
    _, app = run_app(scenario('projects'))
    open_project(app, 'alpha')
    app.click('button', 'MCP, skills et plugins du projet')
    assert app.text_visible('Serveurs MCP')


def test_recharger_la_configuration_sans_session_en_cours(run_app):
    fake, app = run_app(scenario('projects'))
    open_project(app, 'alpha')
    app.click('button', contains='Recharger la configuration du projet')
    req = fake.wait_request('POST', '/instance/dispose')
    assert req['query']['directory'] == ALPHA


def test_recharger_la_configuration_demande_confirmation_si_occupe(run_app):
    data = scenario('projects')
    data['statuses'] = {'ses_a1': {'type': 'busy'}}
    fake, app = run_app(data)
    open_project(app, 'alpha')
    app.click('button', contains='Recharger la configuration du projet')
    assert app.text_visible('Recharger la configuration ?')
    time.sleep(0.3)
    assert not fake.requests('POST', '/instance/dispose')
    app.click('button', 'Recharger', within=app.dialog())
    fake.wait_request('POST', '/instance/dispose')
