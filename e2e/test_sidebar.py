"""Barre latérale : projets, favoris, recherche, arbre des sessions ouvertes, menus contextuels."""

import time

from conftest import scenario, wait_until

ALPHA = '/tmp/opencode-fake/alpha'
BETA = '/tmp/opencode-fake/beta'


def busy(data: dict, session: str) -> dict:
    data['statuses'] = {session: {'type': 'busy'}}
    return data


def test_projets_listes(run_app):
    _, app = run_app(scenario('projects'))
    assert app.find('list item', 'alpha')
    assert app.find('list item', 'béta-projet')


def test_mode_favoris_vide_puis_tous(run_app):
    _, app = run_app(scenario('projects'), settings={'sidebarMode': 'favorites'})
    assert app.text_visible('Aucun favori')
    app.click('button', 'Voir tous les projets')
    app.find('list item', 'alpha')
    wait_until(lambda: app.settings().get('sidebarMode') == 'all', 5, 'mode « Tous » enregistré')


def test_etoile_ajoute_un_favori(run_app):
    _, app = run_app(scenario('projects'))
    app.click('button', 'Ajouter aux favoris')
    wait_until(lambda: app.settings().get('favorites') == [ALPHA], 5, 'favori enregistré')
    app.click('radio button', 'Favoris')
    # mode Favoris : seul le favori reste
    app.find('list item', 'alpha')
    wait_until(lambda: not app.has('list item', 'béta-projet'), 5, 'projet non favori masqué')
    app.click('button', 'Retirer des favoris')
    wait_until(lambda: app.settings().get('favorites') == [], 5, 'favori retiré')


def test_recherche_de_projet_sans_accent(run_app):
    _, app = run_app(scenario('projects'))
    app.key('<Control>k')
    app.type('beta')
    wait_until(lambda: not app.has('list item', 'alpha'), 5, 'alpha filtré')
    app.find('list item', 'béta-projet')
    app.key('Return')
    # Entrée : le projet trouvé s'affiche
    app.find('list item', 'Documentation')


def test_recherche_sans_resultat(run_app):
    _, app = run_app(scenario('projects'))
    app.key('<Control>k')
    app.type('zzz')
    assert app.text_visible('Aucun projet')


def test_recharger_relit_les_sessions(run_app):
    fake, app = run_app(scenario('projects'))
    before = len(fake.requests('GET', '/experimental/session'))
    app.click('button', 'Recharger')
    wait_until(lambda: len(fake.requests('GET', '/experimental/session')) > before, 5, 'sessions relues')


def test_session_ouverte_sous_son_projet_et_repli(run_app):
    _, app = run_app(scenario('projects'), settings={'openSessions': ['ses_a1']})
    app.find('list item', "Refonte de l'API")
    app.click('button', 'Replier')
    wait_until(lambda: app.settings().get('collapsed') == ['prj_alpha'], 5, 'repli enregistré')
    # la session reste dans la liste de la page projet, mais plus sous le projet replié
    wait_until(lambda: len(app.all('list item', "Refonte de l'API")) == 1, 5, 'session masquée')
    app.click('button', 'Déplier')
    wait_until(lambda: app.settings().get('collapsed') == [], 5, 'dépli enregistré')


def test_fermer_une_session_ouverte(run_app):
    _, app = run_app(scenario('projects'), settings={'openSessions': ['ses_a1']})
    app.click('button', 'Fermer (Ctrl+W)')
    wait_until(lambda: app.settings().get('openSessions') == [], 5, 'session fermée')


def test_projet_signale_une_session_en_cours(run_app):
    _, app = run_app(busy(scenario('projects'), 'ses_a1'))
    app.find(None, '1 session en cours')


def test_projet_signale_une_demande_en_attente(run_app):
    data = scenario('projects')
    data['permissions'] = [{'id': 'per_1', 'sessionID': 'ses_a2', 'permission': 'bash', 'patterns': ['ls']}]
    _, app = run_app(data)
    # pastille : texte « 1 », infobulle en description accessible
    badge = app.find('label', '1')
    assert badge.description == '1 session attend ta réponse'


def test_session_ouverte_affiche_son_activite(run_app):
    _, app = run_app(busy(scenario('projects'), 'ses_a1'), settings={'openSessions': ['ses_a1']})
    app.find(None, 'En cours')


def test_menu_projet_nouvelle_session(run_app):
    fake, app = run_app(scenario('projects'))
    app.menu(app.find('list item', 'béta-projet'), 'Nouvelle session')
    req = fake.wait_request('POST', '/session')
    assert req['query']['directory'] == BETA
    # la nouvelle session s'ouvre (compositeur affiché)
    app.composer()


def test_menu_projet_ouvrir_le_dossier(run_app):
    _, app = run_app(scenario('projects'))
    app.menu(app.find('list item', 'alpha'), 'Ouvrir le dossier')
    assert app.logged('DOSSIER', ALPHA)


def test_menu_projet_toutes_les_sessions(run_app):
    _, app = run_app(scenario('projects'))
    app.menu(app.find('list item', 'béta-projet'), 'Toutes les sessions…')
    app.find('list item', 'Documentation')


def test_menu_projet_recharger_la_configuration(run_app):
    fake, app = run_app(scenario('projects'))
    app.menu(app.find('list item', 'alpha'), 'Recharger la configuration')
    req = fake.wait_request('POST', '/instance/dispose')
    assert req['query']['directory'] == ALPHA


def test_menu_projet_mcp(run_app):
    _, app = run_app(scenario('projects'))
    app.menu(app.find('list item', 'alpha'), 'MCP, skills et plugins…')
    assert app.text_visible('Serveurs MCP')


def test_menu_projet_favori(run_app):
    _, app = run_app(scenario('projects'))
    app.menu(app.find('list item', 'béta-projet'), 'Ajouter aux favoris')
    wait_until(lambda: app.settings().get('favorites') == [BETA], 5, 'favori enregistré')


def test_menu_session_renommer(run_app):
    fake, app = run_app(scenario('projects'), settings={'openSessions': ['ses_a1']})
    rows = [n for n in app.all('list item', "Refonte de l'API")]
    app.menu(rows[0], 'Renommer…')
    field = app.find('text', None)
    field.text = 'API v2'
    app.click('button', 'Renommer')
    req = fake.wait_request('PATCH', '/session/ses_a1')
    assert req['body'] == {'title': 'API v2'}
    app.find('list item', 'API v2')


def test_menu_session_forker(run_app):
    fake, app = run_app(scenario('projects'), settings={'openSessions': ['ses_a1']})
    app.menu(app.all('list item', "Refonte de l'API")[0], 'Forker')
    fake.wait_request('POST', '/session/ses_a1/fork')
    assert app.text_visible("Refonte de l'API (fork #1)")


def test_menu_session_supprimer_avec_confirmation(run_app):
    fake, app = run_app(scenario('projects'), settings={'openSessions': ['ses_a1']})
    app.menu(app.all('list item', "Refonte de l'API")[0], 'Supprimer…')
    assert app.text_visible('Supprimer la session ?')
    app.click('button', 'Annuler')
    time.sleep(0.5)
    assert not fake.requests('DELETE')
    app.menu(app.all('list item', "Refonte de l'API")[0], 'Supprimer…')
    app.click('button', 'Supprimer', within=app.dialog())
    fake.wait_request('DELETE', '/session/ses_a1')
    wait_until(lambda: 'ses_a1' not in app.settings().get('openSessions', []), 5, 'session retirée des sessions ouvertes')


def test_menu_session_fermer(run_app):
    _, app = run_app(scenario('projects'), settings={'openSessions': ['ses_a1']})
    app.menu(app.all('list item', "Refonte de l'API")[0], 'Fermer')
    wait_until(lambda: app.settings().get('openSessions') == [], 5, 'session fermée')
