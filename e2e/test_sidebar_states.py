"""Barre latérale, en tête de l'arbre (#178) : action requise, réponse à lire, en cours."""

import time

from conftest import scenario, wait_until

GROUPS = ('Action requise', 'Réponse à lire', 'En cours')
TITLES = ('Corriger le bug de connexion', 'Permission en attente')


def texts(app) -> list:
    within = app.find('list', 'Sessions par état', showing=False)
    return within.findChildren(lambda n: n.roleName == 'label' and n.showing)


def labels(app) -> list[str]:
    """Titres de groupe et de session de l'en-tête, dans l'ordre."""
    return [l.name for l in texts(app) if l.name in GROUPS + TITLES]


def test_en_tete_au_dessus_de_l_arbre(run_app):
    _, app = run_app(scenario('demo'), settings={'openSessions': ['ses_a']})
    # permission en attente (session non ouverte) ; la session ouverte inactive n'y est pas
    wait_until(lambda: labels(app) == ['Action requise', 'Permission en attente'], 10, 'en-tête')
    assert any(l.name.startswith('demo ·') for l in texts(app))
    # l'arbre des projets reste dessous
    app.find('list item', contains='demo')


def test_reponse_a_lire_puis_mise_de_cote(run_app):
    _, app = run_app(scenario('demo'), settings={'openSessions': ['ses_a']})
    app.text_visible('Action requise')
    app.emit('session.execution.started', {'sessionID': 'ses_a'})
    wait_until(lambda: 'En cours' in labels(app), 5, 'en cours')
    app.emit('session.execution.succeeded', {'sessionID': 'ses_a'})
    wait_until(lambda: labels(app) == ['Action requise', 'Permission en attente', 'Réponse à lire', 'Corriger le bug de connexion'], 5, 'réponse à lire')
    wait_until(lambda: app.settings().get('toRead') == ['ses_a'], 5, 'réponse à lire enregistrée')
    # ouvrir la session ne la met pas de côté
    app.click('list item', contains='Corriger le bug de connexion', within=app.find('list', 'Sessions par état'))
    time.sleep(0.5)
    assert app.settings().get('toRead') == ['ses_a']
    app.click('button', 'Mettre de côté')
    wait_until(lambda: app.settings().get('toRead') == [], 5, 'mise de côté')
    wait_until(lambda: 'Réponse à lire' not in labels(app), 5, 'groupe vidé')


def test_fermer_retire_la_reponse_a_lire(run_app):
    _, app = run_app(scenario('demo'), settings={'openSessions': ['ses_a']})
    app.text_visible('Action requise')
    app.emit('session.execution.started', {'sessionID': 'ses_a'})
    wait_until(lambda: 'En cours' in labels(app), 5, 'en cours')
    app.emit('session.execution.succeeded', {'sessionID': 'ses_a'})
    wait_until(lambda: app.settings().get('toRead') == ['ses_a'], 5, 'réponse à lire')
    app.click('button', 'Fermer (Ctrl+W)', within=app.find('list', 'Sessions par état'))
    wait_until(lambda: app.settings().get('toRead') == [] and app.settings().get('openSessions') == [], 5, 'fermée et retirée')


def test_session_fermee_terminee_pas_a_lire(run_app):
    _, app = run_app(scenario('demo'), settings={'openSessions': []})
    app.text_visible('Action requise')
    app.emit('session.execution.started', {'sessionID': 'ses_a'})
    wait_until(lambda: 'En cours' in labels(app), 5, 'en cours')
    app.emit('session.execution.succeeded', {'sessionID': 'ses_a'})
    wait_until(lambda: 'En cours' not in labels(app), 5, 'tour terminé')
    assert app.settings().get('toRead', []) == []


def test_en_tete_masque_sans_session_a_suivre(run_app):
    _, app = run_app(scenario('projects'))
    app.find('list item', contains='alpha')
    time.sleep(0.5)
    assert not app.has('label', 'Action requise')


def test_recherche_sur_le_titre_garde_l_en_tete(run_app):
    _, app = run_app(scenario('demo'))
    app.text_visible('Action requise')
    app.key('<Control>k')
    app.type('attente')
    # aucun projet ne correspond, mais la session de l'en-tête oui : pas de « Aucun projet »
    wait_until(lambda: labels(app) == ['Action requise', 'Permission en attente'], 5, 'en-tête filtré')
    assert not app.has(None, 'Aucun projet')
