"""Commandes shell en cours lancées par l'agent (#182) : bouton de l'en-tête, sortie, arrêt."""

import time

from conftest import scenario, wait_until

DIR = '/tmp/opencode-fake/demo'


def shell(id_: str, command: str, output: str = '') -> dict:
    return {'id': id_, 'status': 'running', 'command': command, 'cwd': DIR, 'shell': '/bin/sh', 'file': f'/tmp/{id_}.out',
            'metadata': {'sessionID': 'ses_a'}, 'time': {'started': int(time.time() * 1000) - 65_000}, 'output': output}


def test_commande_en_cours_sortie_et_arret(run_app):
    data = scenario('demo')
    data['shells'] = [shell('sh_1', 'pnpm dev', 'serveur prêt sur le port 5173\n')]
    fake, app = run_app(data, '--session', 'ses_a')
    button = app.find('toggle button', contains='1 commande en cours')
    button.doActionNamed('click')
    app.text_visible('pnpm dev')
    app.click(None, 'Sortie')
    assert app.text_visible('serveur prêt sur le port 5173')
    app.click('button', 'Arrêter la commande')
    fake.wait_request('DELETE', '/api/shell/sh_1')
    wait_until(lambda: not app.has('toggle button', contains='commande en cours'), 5, 'bouton masqué')


def test_nouvelle_commande_par_evenement(run_app):
    _, app = run_app(scenario('demo'), '--session', 'ses_a')
    app.text_visible('La connexion échoue')
    assert not app.has('toggle button', contains='commande en cours')
    info = shell('sh_2', 'pnpm test')
    info.pop('output')
    app.emit('shell.created', {'info': info})
    app.find('toggle button', contains='1 commande en cours', timeout=5)
    app.emit('shell.exited', {'id': 'sh_2', 'status': 'exited', 'exit': 0})
    wait_until(lambda: not app.has('toggle button', contains='commande en cours'), 5, 'bouton masqué')


def test_commande_d_une_autre_session_non_comptee(run_app):
    data = scenario('demo')
    other = shell('sh_3', 'sleep 100')
    other['metadata'] = {'sessionID': 'ses_b'}
    data['shells'] = [other]
    fake, app = run_app(data, '--session', 'ses_a')
    app.text_visible('La connexion échoue')
    fake.wait_request('GET', '/api/shell')
    time.sleep(0.5)
    assert not app.has('toggle button', contains='commande en cours')
