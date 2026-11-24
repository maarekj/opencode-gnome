"""Panneau d'actions rapide (Ctrl+P) : sessions à suivre, filtre, ouverture au clavier, actions."""

from conftest import scenario, wait_until


def open_panel(app):
    app.key('<Control>p')
    return app.find('entry', 'Actions rapides')


def test_sessions_a_suivre_par_defaut(run_app):
    _, app = run_app(scenario('demo'))
    open_panel(app)
    # ses_b a une permission en attente : affichée dans « À suivre »
    app.find('label', 'À suivre')
    app.find('label', 'Permission demandée')
    app.find('label', 'Sessions récentes')
    app.find('label', 'Projets')
    app.find('label', 'Actions')


def test_ouvrir_une_session_au_clavier(run_app):
    fake, app = run_app(scenario('demo'))
    open_panel(app)
    app.type('Corriger')
    # Entrée : première ligne (la session trouvée)
    app.key('Return')
    wait_until(lambda: not app.has('entry', 'Actions rapides'), 5, 'panneau fermé')
    assert app.text_visible('La connexion échoue après une mise en veille.')
    assert fake.requests('GET', '/api/session/ses_a/message')


def test_filtrer_une_action(run_app):
    _, app = run_app(scenario('demo'))
    open_panel(app)
    app.type('Préférences')
    app.key('Return')
    app.find('dialog', 'Préférences')


def test_aucun_resultat(run_app):
    _, app = run_app(scenario('demo'))
    open_panel(app)
    app.type('zzzzzzzz')
    assert app.text_visible('Rien ne correspond')


DEMO = '/tmp/opencode-fake/demo'
TOOLS = {
    'links': {DEMO: [{'id': 'l1', 'name': 'Front local', 'url': 'http://localhost:8080'}]},
    'terminals': {DEMO: [{'id': 't1', 'name': 'Serveur dev', 'command': 'pnpm start'}]},
}


def test_terminaux_et_liens_du_projet_courant(run_app):
    _, app = run_app(scenario('demo'), '--session', 'ses_a', settings=TOOLS)
    open_panel(app)
    # champ vide : terminaux et liens du projet affiché
    app.find('label', 'Terminaux')
    app.find('label', 'Serveur dev')
    app.find('label', 'Liens')
    app.find('label', 'Front local')


def test_ouvrir_un_lien_au_clavier(run_app):
    _, app = run_app(scenario('demo'), '--session', 'ses_a', settings=TOOLS)
    open_panel(app)
    app.type('front')
    app.key('Return')
    assert app.logged('LIEN', 'localhost:8080')
