"""Dialogue « MCP, skills et plugins » : serveurs MCP, outils (faux MCP stdio), skills, plugins."""

import json
import time

from conftest import SCENARIOS, scenario, wait_until

DIR = '/tmp/opencode-fake/ext'


def data() -> dict:
    return json.loads(json.dumps(scenario('extensions')).replace('__E2E__', str(SCENARIOS.parent)))


def open_project_dialog(run_app):
    fake, app = run_app(data())
    app.click('list item', 'ext')
    app.click('button', 'MCP, skills et plugins du projet')
    dialog = app.find('dialog', 'MCP, skills et plugins — ext')
    return fake, app, dialog


def test_serveurs_badges_et_portee(run_app):
    _, app, _ = open_project_dialog(run_app)
    app.find('list item', 'notes')
    app.find('label', 'Connecté')
    app.find('label', 'Échec')
    app.find('label', 'Authentification requise')
    assert len(app.all('label', 'projet · local')) == 2
    app.find('label', 'global · distant')


def test_dialogue_global_depuis_le_menu(run_app):
    fake, app = run_app(data())
    app.click('toggle button', 'Menu principal')
    app.find('menu item', 'MCP, skills et plugins (global)').doActionNamed('click')
    app.find('dialog', 'MCP, skills et plugins — global')
    app.find('label', 'Déclarés dans ~/.config/opencode/opencode.json')


def test_deconnecter_puis_connecter(run_app):
    fake, app, _ = open_project_dialog(run_app)
    app.toggle('switch', 'Déconnecter')
    fake.wait_request('POST', '/mcp/notes/disconnect')
    app.find('label', 'Désactivé')
    app.toggle('switch', 'Connecter')
    assert fake.wait_request('POST', '/mcp/casse/connect') or fake.wait_request('POST', '/mcp/notes/connect')


def test_recharger(run_app):
    fake, app, dialog = open_project_dialog(run_app)
    n = len(fake.requests('GET', '/mcp'))
    app.click('button', 'Recharger', within=dialog)
    wait_until(lambda: len(fake.requests('GET', '/mcp')) > n, 5, 'serveurs MCP relus')


def test_details_d_un_serveur_en_echec(run_app):
    _, app, _ = open_project_dialog(run_app)
    app._point(app.find('list item', 'casse'), 'b1c')
    assert app.text_visible('ENOENT: /nexistepas/mcp')
    assert app.text_visible('/nexistepas/mcp')


def test_voir_les_outils_d_un_mcp_local(run_app):
    _, app, _ = open_project_dialog(run_app)
    app._point(app.find('list item', 'notes'), 'b1c')
    # bouton « Voir les outils » : nommé par sa ligne (« Outils »)
    app.click('button', 'Outils')
    app.find('label', '2 outils · clic : description complète et paramètres', timeout=20)
    item = app.find('list item', 'search_notes')
    app._point(item, 'b1c')
    app.find('label', 'Texte cherché')
    app.find('label', 'défaut : 10')
    app.find('list item', 'ping')


def test_outils_d_un_mcp_injoignable(run_app):
    _, app, _ = open_project_dialog(run_app)
    app._point(app.find('list item', 'casse'), 'b1c')
    # bouton « Voir les outils » : nommé par sa ligne (« Outils »)
    app.click('button', 'Outils')
    assert app.text_visible('Impossible de lister les outils', timeout=20)


def test_skills_par_provenance(run_app):
    _, app, _ = open_project_dialog(run_app)
    app.click('page tab', 'Skills')
    app.find('label', 'pdf')
    app.find('label', 'Lire des PDF')
    app.find('label', contains='Intégrés à opencode')
    app.click('button', 'Ouvrir le SKILL.md')
    assert app.logged('FICHIER', f'{DIR}/.opencode/skill/pdf/SKILL.md')


def test_plugins_projet_et_global(run_app):
    _, app, _ = open_project_dialog(run_app)
    app.click('page tab', 'Plugins')
    app.find(None, contains='opencode-wakatime')
    app.find(None, contains='local.ts')
