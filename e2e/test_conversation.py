"""Scénarios utilisateur sur une conversation (seul opencode est simulé)."""

from conftest import scenario, wait_until


def test_ouvrir_une_session_depuis_le_projet(run_app):
    fake, app = run_app(scenario('demo'))
    app.click('list item', 'Corriger le bug de connexion')
    assert app.text_visible('La connexion échoue après une mise en veille.')
    assert app.text_visible('chien de garde')
    assert fake.requests('GET', '/session/ses_a/message')


def test_envoyer_un_prompt(run_app):
    fake, app = run_app(scenario('demo'), '--session', 'ses_a')
    app.text_visible('La connexion échoue')
    app.type_in_composer('Peux-tu ajouter un test ?')
    req = fake.wait_request('POST', '/session/ses_a/prompt_async')
    assert req['body']['parts'][0]['text'] == 'Peux-tu ajouter un test ?'
    assert req['body']['model'] == {'providerID': 'fake', 'modelID': 'fake-model'}
    assert app.text_visible('Réponse simulée : Peux-tu ajouter un test ?')


def test_autoriser_une_permission(run_app):
    fake, app = run_app(scenario('demo'), '--session', 'ses_b')
    assert app.text_visible('pnpm test')
    app.click('button', 'Autoriser')
    req = fake.wait_request('POST', '/permission/per_1/reply')
    assert req['body']['reply'] == 'once'
    # la carte de permission disparaît
    wait_until(lambda: not app.has('button', 'Autoriser'), 5, 'carte de permission retirée')


def test_forker_a_partir_d_un_message(run_app):
    fake, app = run_app(scenario('demo'), '--session', 'ses_a')
    app.text_visible('La connexion échoue')
    app.click('button', contains='Forker à partir de ce message')
    req = fake.wait_request('POST', '/session/ses_a/fork')
    assert req['body']['messageID'] == 'msg_001'
    # la copie s'ouvre, le message est pré-rempli dans le compositeur
    assert app.text_visible('Corriger le bug de connexion (fork #1)')
    wait_until(lambda: 'La connexion échoue' in (app.composer().text or ''), 5, 'compositeur pré-rempli')


def test_charger_les_messages_precedents(run_app):
    data = scenario('demo')
    # 250 messages : 200 chargés à l'ouverture, les 50 premiers à la demande
    msgs = []
    for i in range(250):
        mid = f'msg_{i:04d}'
        msgs.append({
            'info': {'id': mid, 'role': 'user', 'sessionID': 'ses_a', 'time': {'created': 1792900000000 + i * 1000}},
            'parts': [{'id': f'prt_{i:04d}', 'type': 'text', 'messageID': mid, 'sessionID': 'ses_a', 'text': f'Message numéro {i}'}],
        })
    data['messages']['ses_a'] = msgs
    fake, app = run_app(data, '--session', 'ses_a')
    assert app.text_visible('Message numéro 249')
    assert not app.has('label', contains='Message numéro 0\n')
    app.click('button', 'Charger les messages précédents')
    wait_until(lambda: any('before' in r['query'] for r in fake.requests('GET', '/session/ses_a/message')), 10, 'page précédente demandée')
    assert app.text_visible('Message numéro 0')
    # début de la session atteint : plus de bouton
    wait_until(lambda: not app.has('button', 'Charger les messages précédents'), 5, 'bouton retiré')


def test_supprimer_une_session_par_double_clic(run_app):
    fake, app = run_app(scenario('demo'))
    rows = app.root.findChildren(lambda n: n.roleName == 'button' and n.name == 'Supprimer' and n.showing)
    assert rows, 'bouton Supprimer introuvable'
    rows[0].doActionNamed('click')
    # premier clic : confirmation dans le bouton, rien d'envoyé
    app.find('button', 'Supprimer ?')
    assert not fake.requests('DELETE')
    app.click('button', 'Supprimer ?')
    req = fake.wait_request('DELETE', '/session/ses_a')
    assert req
    wait_until(lambda: not app.has('list item', 'Corriger le bug de connexion'), 5, 'session retirée de la liste')
