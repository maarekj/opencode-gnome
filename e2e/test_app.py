"""Application : lancement, raccourcis, serveur injoignable, notifications, fermeture."""

import time

import pytest
import shutil
from conftest import scenario, wait_until

DIR = '/tmp/opencode-fake/demo'


def test_seconde_instance_ouvre_la_session_demandee(run_app):
    _, app = run_app(scenario('demo'), '--session', 'ses_a')
    app.text_visible('La connexion échoue')
    app.second_instance('--session', 'ses_b')
    assert app.text_visible('Lance les tests.')
    # une seule fenêtre principale
    assert len(app.all('frame', 'opencode')) == 1


def test_ctrl_w_ferme_la_session_affichee(run_app):
    _, app = run_app(scenario('demo'), '--session', 'ses_a', settings={'openSessions': ['ses_b', 'ses_a']})
    app.text_visible('La connexion échoue')
    app.key('<Control>w')
    wait_until(lambda: app.settings().get('openSessions') == ['ses_b'], 5, 'session fermée')
    # la session ouverte précédente s'affiche
    assert app.text_visible('Lance les tests.')
    app.key('<Control>w')
    wait_until(lambda: app.settings().get('openSessions') == [], 5, 'dernière session fermée')
    app.find('button', 'Nouvelle session')


def test_serveur_injoignable_puis_reconnexion(run_app):
    fake, app = run_app(scenario('demo'))
    fake.stop()
    app.find(None, contains='Serveur opencode injoignable', timeout=20)
    app.click('button', 'Démarrer')
    assert app.logged('SYSTEMCTL', 'start opencode-gnome-server.service')
    fake.start()
    # reconnexion du flux : état rechargé, bandeau retiré
    wait_until(lambda: fake.requests('GET', '/experimental/session'), 20, 'état rechargé après reconnexion')
    wait_until(lambda: not app.has(None, contains='Serveur opencode injoignable'), 20, 'bandeau retiré')


def test_notification_de_permission_et_reponse_par_le_bouton(run_app):
    fake, app = run_app(scenario('demo'))
    # session non affichée : la demande est notifiée
    app.emit('permission.asked', {'id': 'per_1', 'sessionID': 'ses_b', 'permission': 'bash', 'patterns': ['pnpm test']})
    line = app.logged('NOTIF', 'permission per_1', timeout=10)
    assert 'Permission en attente' in line
    # bouton « Autoriser » de la notification : action de l'application
    app.action('reply-permission', f"('ses_b', '{DIR}', 'per_1', 'once')")
    req = fake.wait_request('POST', '/permission/per_1/reply')
    assert req['body']['reply'] == 'once'


def test_notification_de_session_terminee(run_app):
    _, app = run_app(scenario('demo'))
    app.emit('session.status', {'sessionID': 'ses_a', 'status': {'type': 'busy'}})
    time.sleep(0.5)
    app.emit('session.status', {'sessionID': 'ses_a', 'status': {'type': 'idle'}})
    app.emit('session.idle', {'sessionID': 'ses_a'})
    line = app.logged('NOTIF', 'Corriger le bug de connexion', timeout=10)
    assert line


def test_notification_de_question(run_app):
    fake, app = run_app(scenario('demo'))
    fake.post('/__test/emit', {'payload': {'type': 'question.asked', 'properties': {'id': 'que_x', 'sessionID': 'ses_a', 'questions': [{'question': 'Continuer ?', 'options': [{'label': 'Oui'}]}]}}})
    assert app.logged('NOTIF', 'Corriger le bug de connexion', timeout=10)


def test_fermeture_avec_terminal_integre_ouvert(run_app):
    _, app = run_app(scenario('demo'))
    app.click('list item', 'demo')
    app.key('<Control><Shift>j')
    app.click('button', 'Nouveau shell (dossier de la session ou du projet)')
    app.find('page tab', contains='Shell')
    app.find('frame', 'opencode').doActionNamed('window.close')
    dialog = app.find('alert', 'Des terminaux intégrés sont ouverts')
    app.click('button', 'Annuler', within=dialog)
    time.sleep(0.5)
    assert app.has('frame', 'opencode')
    app.find('frame', 'opencode').doActionNamed('window.close')
    app.click('button', 'Fermer', within=app.find('alert', 'Des terminaux intégrés sont ouverts'))
    wait_until(lambda: app.proc.poll() is not None or not app.has('frame', 'opencode'), 10, 'fenêtre fermée')


@pytest.mark.skipif(shutil.which('zellij') is None, reason='zellij absent')
def test_fermeture_avec_terminal_persistant(run_app):
    terminal = {'id': 'og-demo-serveur', 'name': 'Serveur', 'command': 'sleep 600'}
    _, app = run_app(scenario('demo'), settings={'terminals': {DIR: [terminal]}})
    app.click('list item', 'demo')
    app.menu(app.find('button', contains='Serveur'), 'Démarrer en arrière-plan')
    app.find(None, 'Arrêter', timeout=20)
    app.find('frame', 'opencode').doActionNamed('window.close')
    dialog = app.find('alert', 'Un terminal tourne encore')
    app.click('button', 'Arrêter', within=dialog)
    wait_until(lambda: app.proc.poll() is not None or not app.has('frame', 'opencode'), 15, 'fenêtre fermée')
