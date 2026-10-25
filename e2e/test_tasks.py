"""Tâches planifiées : fenêtre, éditeur, actions et historique.

systemd n'est jamais touché : en bac à sable (sans OGT_NAMESPACE), les appels `systemctl` sont
journalisés (`SYSTEMCTL …`) au lieu d'être lancés. tasks.json et runs.jsonl sont dans les
dossiers XDG privés du test.
"""

import json
import time

from conftest import Atspi, scenario, wait_until

DIR = '/tmp/opencode-fake/demo'
TASKS = 'config/opencode-gnome/tasks.json'
RUNS = 'data/opencode-gnome/runs.jsonl'

TASK = {
    'id': 'revue',
    'name': 'Revue quotidienne',
    'directory': DIR,
    'prompt': 'Fais la revue du jour.',
    'schedule': 'Mon..Fri *-*-* 09:00:00',
    'timeout': 30,
    'permissions': 'all',
    'session': {'mode': 'new'},
    'enabled': True,
    'created': 1792900000000,
}
RUN_OK = {'run': 'r1', 'task': 'revue', 'trigger': 'schedule', 'status': 'success', 'start': 1792900000000, 'end': 1792900060000, 'session': 'ses_a', 'summary': 'RAS'}
RUN_KO = {'run': 'r2', 'task': 'revue', 'trigger': 'manual', 'status': 'error', 'start': 1792900100000, 'end': 1792900110000, 'error': 'modèle indisponible'}


def with_tasks(tasks=(TASK,), runs=()):
    return {TASKS: {'tasks': list(tasks)}, RUNS: ''.join(json.dumps(r) + '\n' for r in runs)}


def open_window(run_app, files=None, page='Tâches planifiées'):
    fake, app = run_app(scenario('composer'), files=files)
    # « Menu principal — N tâche(s) planifiée(s) en échec » s'il y a des échecs non vus
    app.click('toggle button', contains='Menu principal')
    app.find('menu item', contains=page).doActionNamed('click')
    window = app.find('frame', 'Tâches planifiées')
    return fake, app, window


def editable_texts(app, dialog):
    return [n for n in dialog.findChildren(lambda n: n.roleName == 'text' and n.showing and n.getState().contains(Atspi.StateType.EDITABLE))]


def saved_tasks(app):
    return (app.read(TASKS) or {}).get('tasks', [])


def test_fenetre_vide(run_app):
    _, app, _ = open_window(run_app)
    assert app.text_visible('Aucune tâche planifiée')


def test_creer_une_tache_en_semaine(run_app):
    _, app, window = open_window(run_app)
    app.click('button', 'Nouvelle tâche', within=window)
    dialog = app.find('dialog', 'Nouvelle tâche')
    name, hour, prompt = editable_texts(app, dialog)[:3]
    name.text = 'Veille technique'
    prompt.text = 'Résume les nouveautés.'
    # aperçu de l'horaire calculé en direct
    app.find('label', contains='en semaine à 09:00', within=dialog)
    app.click('button', 'Créer', within=dialog)
    task = wait_until(lambda: saved_tasks(app)[:1], 5, 'tâche enregistrée')[0]
    assert task['name'] == 'Veille technique' and task['prompt'] == 'Résume les nouveautés.'
    assert task['schedule'] == 'Mon..Fri *-*-* 09:00:00' and task['directory'] == DIR
    assert app.logged('SYSTEMCTL', f'enable --now opencode-gnome-task-{task["id"]}.timer')


def test_validations_de_l_editeur(run_app):
    _, app, window = open_window(run_app)
    app.click('button', 'Nouvelle tâche', within=window)
    dialog = app.find('dialog', 'Nouvelle tâche')
    app.click('button', 'Créer', within=dialog)
    assert app.text_visible('Nom requis')
    editable_texts(app, dialog)[0].text = 'Sans prompt'
    app.click('button', 'Créer', within=dialog)
    assert app.text_visible('Prompt requis')
    assert saved_tasks(app) == []


def test_horaire_personnalise_invalide(run_app):
    _, app, window = open_window(run_app)
    app.click('button', 'Nouvelle tâche', within=window)
    dialog = app.find('dialog', 'Nouvelle tâche')
    app.combo('Fréquence', 'Personnalisé (cron ou OnCalendar)', within=dialog)
    texts = editable_texts(app, dialog)
    texts[0].text = 'Tâche'
    # nom, expression, prompt
    texts[1].text = 'pas un horaire'
    app.find('label', contains='Horaire invalide', within=dialog)
    texts[1].text = '30 8 * * 1-5'
    app.find('label', contains='en semaine à 08:30', within=dialog)


def test_tache_manuelle(run_app):
    _, app, window = open_window(run_app)
    app.click('button', 'Nouvelle tâche', within=window)
    dialog = app.find('dialog', 'Nouvelle tâche')
    app.combo('Fréquence', 'À la main uniquement (pas de planification)', within=dialog)
    wait_until(lambda: not [n for n in app.all('switch', 'Activée')], 5, 'interrupteur « Activée » masqué')
    app.find('label', contains='Jamais automatiquement', within=dialog)
    texts = editable_texts(app, dialog)
    texts[0].text = 'À la demande'
    texts[-1].text = 'Fais le point.'
    app.click('button', 'Créer', within=dialog)
    task = wait_until(lambda: saved_tasks(app)[:1], 5, 'tâche enregistrée')[0]
    assert task['schedule'] == ''


def test_lancer_desactiver_supprimer(run_app):
    _, app, window = open_window(run_app, files=with_tasks())
    app.find('list item', contains='Revue quotidienne', within=window)
    app.click('button', 'Lancer maintenant', within=window)
    assert app.logged('SYSTEMCTL', 'start --no-block opencode-gnome-task-revue.service')
    app.toggle('switch', 'Désactiver')
    wait_until(lambda: saved_tasks(app)[0]['enabled'] is False, 5, 'tâche désactivée')
    assert app.logged('SYSTEMCTL', 'disable --now opencode-gnome-task-revue.timer')
    app.click('button', 'Supprimer', within=window)
    dialog = app.find('alert', 'Supprimer la tâche ?')
    app.click('button', 'Supprimer', within=dialog)
    wait_until(lambda: saved_tasks(app) == [], 5, 'tâche supprimée')


def test_modifier_une_tache(run_app):
    _, app, window = open_window(run_app, files=with_tasks())
    app._point(app.find('list item', contains='Revue quotidienne', within=window), 'b1c')
    dialog = app.find('dialog', 'Modifier la tâche')
    name = editable_texts(app, dialog)[0]
    assert name.text == 'Revue quotidienne'
    name.text = 'Revue du matin'
    app.click('button', 'Enregistrer', within=dialog)
    wait_until(lambda: saved_tasks(app)[0]['name'] == 'Revue du matin', 5, 'tâche renommée')


def test_historique_et_echecs_seulement(run_app):
    _, app, window = open_window(run_app, files=with_tasks(runs=(RUN_OK, RUN_KO)))
    app.click('page tab', 'Historique', within=window)
    app.find(None, contains='modèle indisponible', within=window)
    app.find(None, contains='RAS', within=window)
    app.toggle('switch', 'Échecs seulement')
    wait_until(lambda: not app.has(None, contains='RAS'), 5, 'run réussi masqué')
    app.find(None, contains='modèle indisponible', within=window)


def test_historique_ouvre_la_session_du_run(run_app):
    _, app, window = open_window(run_app, files=with_tasks(runs=(RUN_OK,)))
    app.click('page tab', 'Historique', within=window)
    # ligne du run : nommée par la tâche, résumé dans son sous-titre
    app._point(app.find('label', contains='RAS', within=window), 'b1c')
    assert app.text_visible('La connexion échoue après une mise en veille.')


def test_echec_non_vu_signale_dans_le_menu(run_app):
    fake, app = run_app(scenario('composer'), files=with_tasks(runs=(RUN_KO,)))
    app.find(None, contains='tâche planifiée en échec')
    app.click('toggle button', contains='Menu principal')
    app.find('menu item', 'Tâches planifiées (1 échec)').doActionNamed('click')
    window = app.find('frame', 'Tâches planifiées')
    app.find(None, contains='modèle indisponible', within=window)
    # vu : plus de pastille
    wait_until(lambda: not app.has(None, contains='tâche planifiée en échec'), 5, 'échec marqué vu')


def test_taches_sur_la_page_du_projet_et_dans_la_barre_laterale(run_app):
    _, app = run_app(scenario('composer'), files=with_tasks())
    app.click('list item', 'demo')
    app.find('list item', contains='Revue quotidienne')
    rows = app.all('button', 'Lancer maintenant')
    # barre latérale et page du projet
    assert len(rows) == 2
    rows[-1].doActionNamed('click')
    assert app.logged('SYSTEMCTL', 'start --no-block opencode-gnome-task-revue.service')


def test_editeur_charge_modeles_et_agents(run_app):
    _, app, window = open_window(run_app)
    app.click('button', 'Nouvelle tâche', within=window)
    dialog = app.find('dialog', 'Nouvelle tâche')
    app.combo('Agent', 'plan', within=dialog)
    app.find('combo box', 'Agent', within=dialog)
    app.find('label', 'plan', within=dialog)
