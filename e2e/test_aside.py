"""Question annexe (#153) : panneau à droite, fork caché de la session."""

from gi.repository import Atspi

from conftest import scenario, wait_until


def aside_composer(app):
    """Compositeur du panneau : le second champ de saisie affiché (après celui de la session)."""
    def find():
        nodes = app.root.findChildren(lambda n: n.roleName == 'text' and n.showing and n.getState().contains(Atspi.StateType.EDITABLE))
        return nodes[1] if len(nodes) > 1 else None

    return wait_until(find, 10, 'compositeur de la question annexe')


def ask(app, text):
    composer = aside_composer(app)
    composer.text = text
    wait_until(lambda: composer.text == text, 5, 'question saisie')
    app.all('button', contains='Envoyer')[-1].doActionNamed('click')


def aside_id(app):
    """Fork caché de ses_a, une fois enregistré dans les réglages."""
    return wait_until(lambda: app.settings().get('asides', {}).get('ses_a', {}).get('id'), 5, 'question annexe enregistrée')


def open_panel(run_app):
    fake, app = run_app(scenario('demo'), '--session', 'ses_a')
    app.text_visible('La connexion échoue')
    app.click('toggle button', contains='Question annexe')
    app.find(None, contains='sans interrompre l')
    return fake, app


def test_question_annexe_dans_un_fork_cache(run_app):
    fake, app = open_panel(run_app)
    ask(app, 'Pourquoi ce choix ?')
    fork = fake.wait_request('POST', '/session/ses_a/fork')
    # session au repos : copie complète
    assert fork['body'] == {}
    aside = aside_id(app)
    prompt = fake.wait_request('POST', f'/session/{aside}/prompt_async')
    assert prompt['body']['parts'][0]['text'] == 'Pourquoi ce choix ?'
    # même agent et modèle que la session (cache du fournisseur)
    assert prompt['body']['model'] == {'providerID': 'fake', 'modelID': 'fake-model'}
    assert app.text_visible('Réponse simulée : Pourquoi ce choix ?')
    # titre repérable, rien d'envoyé dans la session principale
    rename = fake.wait_request('PATCH', f'/session/{aside}')
    assert rename['body']['title'] == 'Question annexe — Corriger le bug de connexion'
    assert not fake.requests('POST', '/session/ses_a/prompt_async')
    # caché dans la barre latérale
    assert not app.has('list item', contains='Question annexe')


def test_supprimer_la_question_annexe(run_app):
    fake, app = open_panel(run_app)
    ask(app, 'Explique')
    assert app.text_visible('Réponse simulée : Explique')
    aside = aside_id(app)
    app.click('button', 'Supprimer la question annexe')
    fake.wait_request('DELETE', f'/session/{aside}')
    wait_until(lambda: 'ses_a' not in app.settings().get('asides', {}), 5, 'annexe oubliée')
    app.find(None, contains='sans interrompre l')


def test_garder_comme_session(run_app):
    fake, app = open_panel(run_app)
    ask(app, 'Détaille')
    assert app.text_visible('Réponse simulée : Détaille')
    aside = aside_id(app)
    app.click('button', contains='Garder comme session')
    wait_until(lambda: 'ses_a' not in app.settings().get('asides', {}), 5, 'annexe devenue session')
    # visible et ouverte dans la barre latérale
    app.find('list item', contains='(question annexe)')
    assert aside in app.settings()['openSessions']


def test_question_annexe_retrouvee_au_panneau_rouvert(run_app):
    fake, app = open_panel(run_app)
    ask(app, 'Première question')
    assert app.text_visible('Réponse simulée : Première question')
    aside = aside_id(app)
    # panneau refermé puis rouvert : même échange, nouvelle question dans le même fork
    app.click('button', contains='Fermer le panneau')
    app.key('<Control><Shift>a')
    assert app.text_visible('Réponse simulée : Première question')
    ask(app, 'Suite')
    assert app.text_visible('Réponse simulée : Suite')
    assert len(fake.requests('POST', '/session/ses_a/fork')) == 1
    assert len(fake.requests('POST', f'/session/{aside}/prompt_async')) == 2
