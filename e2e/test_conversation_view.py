"""Conversation : contenu, outils, cartes de demande, sous-agent, liste de tâches, erreurs."""

import json
import time

from conftest import Atspi, scenario, wait_until

FILE = '/tmp/opencode-fake/conv/src/app.ts'


def conv():
    return scenario('conversation')


def test_markdown_et_reflexion(run_app):
    _, app = run_app(conv(), '--session', 'ses_c')
    assert app.text_visible('Le port vaut 8080')
    app.find(None, contains='Réflexion')


def test_edit_avec_diff_et_ouverture_du_fichier(run_app):
    _, app = run_app(conv(), '--session', 'ses_c')
    app.find('label', '+1')
    # dernier bouton : celui de l'edit (les lectures qui le précèdent ont aussi le leur)
    app.all('button', 'Ouvrir le fichier')[-1].doActionNamed('click')
    assert app.logged('FICHIER', FILE)


def test_read_plage_ouverture_et_contenu(run_app):
    # conversation affichée depuis le haut : les lectures sont à l'écran (dépliées par un vrai clic)
    _, app = run_app(conv(), '--session', 'ses_c', env={'OPENCODE_GNOME_TEST_SCROLL': 'top'})
    # fichier lu en entier (metadata.display) et lecture partielle (sortie brute, offset / limit)
    app.find('label', '2 lignes')
    app.find('label', 'lignes 120–159 sur 300')
    app.all('button', 'Ouvrir le fichier')[0].doActionNamed('click')
    assert app.logged('FICHIER', FILE)
    # déplié : contenu renuméroté (« 120  … » et non « 120: … »), sans l'enveloppe <path>/<content>
    app.click('label', 'src/server.ts')
    assert app.text_visible('120  export function listen()')


def test_copier_un_message(run_app):
    _, app = run_app(conv(), '--session', 'ses_c')
    app.text_visible('Change le port')
    app.all('button', 'Copier le message (markdown)')[0].doActionNamed('click')
    wait_until(lambda: app.clipboard() == 'Change le port et explique.', 5, 'message copié')


def test_masquer_et_afficher_les_outils(run_app):
    _, app = run_app(conv(), '--session', 'ses_c')
    app.find('label', 'pnpm test')
    app.click('toggle button', "Masquer les appels d'outils (Ctrl+Maj+O)")
    wait_until(lambda: not app.has('label', 'pnpm test'), 5, 'outils masqués')
    wait_until(lambda: app.settings().get('showTools') is False, 5, 'réglage enregistré')
    # le sous-agent et la question restent visibles
    app.find('label', '@general')
    app.key('<Control><Shift>o')
    app.find('label', 'pnpm test')


def test_sous_agent_carte_rapport_et_page(run_app):
    _, app = run_app(conv(), '--session', 'ses_c')
    app.find('label', '@general')
    app.click(None, 'Rapport')
    assert app.text_visible('RAS : le changement est correct.')
    # bouton de la carte : nommé par son contenu, l'infobulle « Ouvrir la conversation du sous-agent » en description
    card = app.find('button', contains='@general Relire le changement')
    assert card.description == 'Ouvrir la conversation du sous-agent'
    card.doActionNamed('click')
    assert app.text_visible('Lecture du diff du sous-agent.')
    # lecture seule : pas de compositeur
    time.sleep(0.5)
    assert not app.root.findChildren(lambda n: n.roleName == 'text' and n.showing and n.getState().contains(Atspi.StateType.EDITABLE))
    app.key('<Control>w')
    assert app.text_visible('Change le port et explique.')
    app.composer()


def test_question_choix_unique(run_app):
    fake, app = run_app(conv(), '--session', 'ses_c')
    app.click('radio button', contains='Production')
    app.click('button', 'Répondre')
    req = fake.wait_request('POST', '/question/que_1/reply')
    assert req['body']['answers'] == [['Production']]
    app.find(None, contains='Question répondue')


def test_question_autre_reponse(run_app):
    fake, app = run_app(conv(), '--session', 'ses_c')
    app.click(None, 'Autre réponse…')
    # champ « Ta réponse… » : premier texte éditable (le compositeur est en bas)
    editable = wait_until(lambda: [n for n in app.all('text') if n.getState().contains(Atspi.StateType.EDITABLE)][:2], 5, 'champ de réponse')
    assert len(editable) == 2
    editable[0].text = 'Préproduction'
    app.click('button', 'Répondre')
    req = fake.wait_request('POST', '/question/que_1/reply')
    assert req['body']['answers'] == [['Préproduction']]


def test_question_ignoree(run_app):
    fake, app = run_app(conv(), '--session', 'ses_c')
    app.click('button', 'Ignorer')
    fake.wait_request('POST', '/question/que_1/reject')
    app.find(None, contains='Questions ignorées')


def test_permission_refusee(run_app):
    fake, app = run_app(conv(), '--session', 'ses_p')
    app.click('button', 'Refuser')
    req = fake.wait_request('POST', '/permission/per_p/reply')
    assert req['body']['reply'] == 'reject'
    wait_until(lambda: not app.has('button', 'Refuser'), 5, 'carte retirée')


def test_permission_toujours(run_app):
    fake, app = run_app(conv(), '--session', 'ses_p')
    app.click('button', 'Toujours')
    req = fake.wait_request('POST', '/permission/per_p/reply')
    assert req['body']['reply'] == 'always'


def test_sous_titre_signale_la_demande(run_app):
    _, app = run_app(conv(), '--session', 'ses_p')
    app.find('label', 'Permission demandée')


def test_liste_de_taches(run_app):
    _, app = run_app(conv(), '--session', 'ses_c')
    app.find('label', 'Tâches')
    app.click('button', contains='Tâches 1/3 · En cours : Lancer la revue')
    app.find('label', 'Lancer la revue')
    app.emit('todo.updated', {'sessionID': 'ses_c', 'todos': [{'content': 'Écrire la note de version', 'status': 'pending'}]})
    app.find('label', 'Écrire la note de version')


def test_pastille_des_demandes_hors_ecran(run_app):
    data = conv()
    msgs = data['messages']['ses_p']
    # longue conversation : la carte de permission est hors de l'écran
    filler = [
        {'info': {'id': f'msg_0{i:03d}', 'role': 'user', 'sessionID': 'ses_p', 'time': {'created': 1792800000000 + i}},
         'parts': [{'id': f'prt_0{i:03d}', 'type': 'text', 'messageID': f'msg_0{i:03d}', 'sessionID': 'ses_p', 'text': f'Ligne de remplissage {i}'}]}
        for i in range(40)
    ]
    data['messages']['ses_p'] = filler + msgs
    _, app = run_app(data, '--session', 'ses_p', env={'OPENCODE_GNOME_TEST_SCROLL': 'top'})
    app.click('button', contains='1 permission demandée')
    wait_until(lambda: app.has('button', 'Autoriser'), 5, 'carte de permission atteinte')


def test_erreur_de_chargement_puis_reessayer(run_app):
    data = conv()
    data['failOnce'] = ['GET /session/ses_c/message']
    _, app = run_app(data, '--session', 'ses_c')
    app.click('button', 'Réessayer')
    assert app.text_visible('Change le port et explique.')


def test_messages_annules_masques(run_app):
    data = conv()
    data['sessions'][0]['revert'] = {'messageID': 'msg_003'}
    _, app = run_app(data, '--session', 'ses_c')
    assert app.text_visible('Change le port et explique.')
    time.sleep(0.5)
    assert not app.has('text', None, contains='Délègue la revue')
    assert not app.root.findChildren(lambda n: n.roleName == 'text' and n.showing and 'Délègue la revue' in (n.text or ''))
