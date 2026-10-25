"""Compositeur : envoi, choix d'agent / modèle / niveau, commandes, complétions, historique, pièces jointes."""

import base64
import subprocess
import time

from conftest import scenario, wait_until

DIR = '/tmp/opencode-fake/demo'
# PNG 1×1
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==')


def start(run_app, session='ses_a', **kw):
    data = kw.pop('data', None) or scenario('composer')
    fake, app = run_app(data, '--session', session, **kw)
    app.text_visible('La connexion' if session == 'ses_a' else 'Lance les tests')
    return fake, app


def prompt_body(fake) -> dict:
    return fake.wait_request('POST', '/session/ses_a/prompt_async')['body']


def test_ctrl_entree_envoie(run_app):
    fake, app = start(run_app)
    app.focus_composer()
    app.type('Bonjour')
    app.key('<Control>Return')
    assert prompt_body(fake)['parts'][0]['text'] == 'Bonjour'
    wait_until(lambda: app.composer().text == '', 5, 'compositeur vidé')


def test_echec_d_envoi_conserve_le_texte(run_app):
    data = scenario('composer')
    data['failOnce'] = ['POST /session/ses_a/prompt_async']
    fake, app = start(run_app, data=data)
    app.type_in_composer('Texte précieux')
    fake.wait_request('POST', '/session/ses_a/prompt_async')
    assert app.text_visible('Envoi impossible')
    wait_until(lambda: app.composer().text == 'Texte précieux', 5, 'texte rendu au compositeur')


def test_choix_de_l_agent(run_app):
    fake, app = start(run_app)
    app.click('toggle button', 'build')
    app.choose('plan')
    app.find('toggle button', 'plan')
    app.type_in_composer('Planifie')
    assert prompt_body(fake)['agent'] == 'plan'


def test_choix_du_modele(run_app):
    fake, app = start(run_app)
    app.click('toggle button', 'fake/fake-model')
    app.choose('fake/other-model')
    app.find('toggle button', 'fake/other-model')
    app.type_in_composer('Autre')
    assert prompt_body(fake)['model'] == {'providerID': 'fake', 'modelID': 'other-model'}


def test_niveau_de_raisonnement_et_ctrl_t(run_app):
    fake, app = start(run_app)
    app.click('toggle button', 'Par défaut')
    app.choose('high')
    app.find('toggle button', 'high')
    app.type_in_composer('Réfléchis')
    assert prompt_body(fake)['variant'] == 'high'
    # Ctrl+T : niveau suivant (retour au premier)
    app.focus_composer()
    app.key('<Control>t')
    wait_until(lambda: not app.has('toggle button', 'high'), 5, 'niveau changé')


def test_jauge_de_contexte_apres_une_reponse(run_app):
    _, app = start(run_app)
    app.type_in_composer('Question')
    app.text_visible('Réponse simulée : Question')
    app.find('label', contains=' %')


def test_interrompre(run_app):
    fake, app = start(run_app, session='ses_b')
    app.click('button', 'Interrompre')
    fake.wait_request('POST', '/session/ses_b/abort')


def test_completion_des_commandes(run_app):
    fake, app = start(run_app)
    app.focus_composer()
    app.type('/rev')
    app.find('label', '/review')
    app.find('label', 'Relire le code')
    app.key('Tab')
    wait_until(lambda: app.composer().text.startswith('/review '), 5, 'commande complétée')
    app.type('main')
    app.key('<Control>Return')
    req = fake.wait_request('POST', '/session/ses_a/command')
    assert req['body']['command'] == 'review'
    assert req['body']['arguments'] == 'main'


def test_completion_badges(run_app):
    _, app = start(run_app)
    app.focus_composer()
    app.type('/')
    app.find('label', '/pdf')
    app.find('label', 'skill')
    app.find('label', 'intégrée')
    app.key('Escape')
    wait_until(lambda: not app.has('label', '/pdf'), 5, 'complétion fermée')


def builtin(app, text: str) -> None:
    app.focus_composer()
    app.type(text)
    # complétion encore ouverte (commande sans argument) : fermée, sans toucher au texte
    if app.has('label', 'intégrée'):
        app.key('Escape')
    app.key('<Control>Return')


def test_compact(run_app):
    fake, app = start(run_app)
    builtin(app, '/compact')
    fake.wait_request('POST', '/session/ses_a/summarize')


def test_undo_puis_redo(run_app):
    fake, app = start(run_app)
    builtin(app, '/undo')
    req = fake.wait_request('POST', '/session/ses_a/revert')
    assert req['body']['messageID'] == 'msg_001'
    # le prompt annulé revient dans le compositeur
    wait_until(lambda: 'La connexion échoue' in app.composer().text, 5, 'prompt rendu')
    app.composer().text = ''
    builtin(app, '/redo')
    fake.wait_request('POST', '/session/ses_a/unrevert')


def test_new(run_app):
    fake, app = start(run_app)
    builtin(app, '/new')
    req = fake.wait_request('POST', '/session')
    assert req['query']['directory'] == DIR


def test_share_et_unshare(run_app):
    fake, app = start(run_app)
    builtin(app, '/share')
    fake.wait_request('POST', '/session/ses_a/share')
    wait_until(lambda: app.clipboard() == 'https://example.invalid/s/ses_a', 5, 'lien copié')
    builtin(app, '/unshare')
    fake.wait_request('DELETE', '/session/ses_a/share')


def test_rename(run_app):
    fake, app = start(run_app)
    builtin(app, '/rename Nouveau titre')
    req = fake.wait_request('PATCH', '/session/ses_a')
    assert req['body'] == {'title': 'Nouveau titre'}


def test_fork(run_app):
    fake, app = start(run_app)
    builtin(app, '/fork')
    fake.wait_request('POST', '/session/ses_a/fork')
    assert app.text_visible('Corriger le bug de connexion (fork #1)')


def test_mention_de_fichier(run_app):
    fake, app = start(run_app)
    app.focus_composer()
    app.type('Lis @app')
    # ligne de complétion : nom du fichier, dossier en dessous
    app.find('label', 'app.ts')
    app.key('Tab')
    wait_until(lambda: '@src/app.ts' in app.composer().text, 5, 'mention insérée')
    app.key('<Control>Return')
    parts = prompt_body(fake)['parts']
    files = [p for p in parts if p['type'] == 'file']
    assert files and files[0]['url'] == f'file://{DIR}/src/app.ts'


def test_mention_d_un_dossier_puis_descente(run_app):
    _, app = start(run_app)
    app.focus_composer()
    app.type('@src/')
    # chemin terminé par « / » : le contenu du dossier est proposé
    app.find('label', 'util.ts')
    app.key('Tab')
    wait_until(lambda: app.composer().text.startswith('@src/'), 5, 'élément du dossier inséré')


def test_historique_haut_bas(run_app):
    _, app = start(run_app)
    app.focus_composer()
    app.key('Up')
    wait_until(lambda: app.composer().text == 'La connexion échoue après une mise en veille.', 5, 'dernier prompt rappelé')
    app.key('Escape')
    wait_until(lambda: app.composer().text == '', 5, 'historique quitté')


def test_coller_une_image_puis_la_retirer(run_app):
    fake, app = start(run_app)
    subprocess.run(['xclip', '-selection', 'clipboard', '-t', 'image/png', '-i'], input=PNG, check=True, timeout=5)
    app.focus_composer()
    app.key('<Control>v')
    app.find('button', 'Retirer')
    app.click('button', 'Retirer')
    wait_until(lambda: not app.has('button', 'Retirer'), 5, 'pièce jointe retirée')
    app.key('<Control>v')
    app.find('button', 'Retirer')
    app.type_in_composer('Voici une capture')
    parts = prompt_body(fake)['parts']
    images = [p for p in parts if p['type'] == 'file']
    assert images and images[0]['mime'] == 'image/png' and images[0]['url'].startswith('data:image/png;base64,')
