"""Session en attente de ses tâches de fond (#184) : sous-agents et commandes en arrière-plan."""

import time

from conftest import scenario, wait_until

DIR = '/tmp/opencode-fake/demo'


def data():
    d = scenario('demo')
    child = dict(d['sessions'][0], id='ses_sub', parentID='ses_a', title='Recherche (@general subagent)')
    d['sessions'].append(child)
    d['messages']['ses_sub'] = []
    return d


def waiting_background(app) -> bool:
    return app.has(None, contains='En attente des tâches de fond')


def test_sous_agent_en_arriere_plan_garde_la_session_en_cours(run_app):
    _, app = run_app(data(), '--session', 'ses_a', settings={'openSessions': ['ses_a']})
    app.text_visible('Corriger le bug de connexion')
    app.emit('session.execution.started', {'sessionID': 'ses_a'})
    app.emit('session.execution.started', {'sessionID': 'ses_sub'})
    time.sleep(1)
    # l'agent finit son tour, le sous-agent travaille encore
    app.emit('session.execution.succeeded', {'sessionID': 'ses_a'})
    wait_until(lambda: app.has(None, contains='1 sous-agent'), 5, 'en attente du sous-agent')
    # réglages enregistrés avec un délai (400 ms) : attente plus longue avant de vérifier
    time.sleep(1.5)
    assert app.settings().get('toRead', []) == []
    assert 'ses_a' not in app.settings().get('unread', [])
    # fin du sous-agent : vraie fin, réponse à lire
    app.emit('session.execution.succeeded', {'sessionID': 'ses_sub'})
    wait_until(lambda: app.settings().get('toRead') == ['ses_a'], 5, 'réponse à lire')
    assert not app.has(None, contains='1 sous-agent')


def test_commande_en_arriere_plan_garde_la_session_en_cours(run_app):
    _, app = run_app(scenario('demo'), '--session', 'ses_a', settings={'openSessions': ['ses_a']})
    app.text_visible('Corriger le bug de connexion')
    app.emit('session.execution.started', {'sessionID': 'ses_a'})
    info = {'id': 'sh_9', 'status': 'running', 'command': 'pnpm test', 'cwd': DIR, 'shell': '/bin/sh', 'file': '/tmp/sh_9.out',
            'metadata': {'sessionID': 'ses_a'}, 'time': {'started': int(time.time() * 1000)}}
    app.emit('shell.created', {'info': info})
    time.sleep(0.5)
    app.emit('session.execution.succeeded', {'sessionID': 'ses_a'})
    wait_until(lambda: app.has(None, contains='1 commande'), 5, 'en attente de la commande')
    time.sleep(1.5)
    assert app.settings().get('toRead', []) == []
    app.emit('shell.exited', {'id': 'sh_9', 'status': 'exited', 'exit': 0})
    wait_until(lambda: app.settings().get('toRead') == ['ses_a'], 5, 'réponse à lire')
