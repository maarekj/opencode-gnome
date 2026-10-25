"""CLI `ocg` : terminaux et liens ajoutés en ligne de commande, affichés en direct par l'application."""

import json
import shutil

import pytest
from conftest import scenario, wait_until

DIR = '/tmp/opencode-fake/demo'


def project(run_app):
    fake, app = run_app(scenario('composer'))
    app.click('list item', 'demo')
    app.find('button', 'Nouvelle session')
    return fake, app


def test_aide(run_app):
    _, app = run_app(scenario('composer'))
    out = app.ocg('help', 'all')
    for text in ('ocg terminal add', 'ocg link add', 'ocg task add', 'Exemples :'):
        assert text in out


def test_lien_ajoute_par_la_cli_affiche_par_l_app(run_app):
    _, app = project(run_app)
    app.ocg('link', 'add', '--name', 'Admin', '--url', 'localhost:8080/admin', '--project', DIR)
    # l'application relit les réglages modifiés par un autre processus
    btn = app.find('button', contains='Admin')
    btn.doActionNamed('click')
    assert app.logged('LIEN', 'http://localhost:8080/admin')
    rows = json.loads(app.ocg('link', 'list', '--json', '--project', DIR))
    assert rows[0]['name'] == 'Admin' and rows[0]['resolved'] == 'http://localhost:8080/admin'


def test_terminal_ajoute_par_la_cli_puis_supprime(run_app):
    _, app = project(run_app)
    app.ocg('terminal', 'add', '--name', 'web', '--command', 'pnpm dev', '--project', DIR)
    app.find('button', contains='web')
    app.ocg('terminal', 'rm', 'web', '--project', DIR)
    wait_until(lambda: not app.has('button', contains='web'), 5, 'terminal retiré de la barre')


def test_l_app_et_la_cli_ecrivent_sans_s_ecraser(run_app):
    _, app = project(run_app)
    # l'app enregistre un réglage, puis la CLI ajoute un lien : les deux sont conservés
    app.click('button', 'Ajouter aux favoris')
    wait_until(lambda: app.settings().get('favorites') == [DIR], 5, 'favori enregistré')
    app.ocg('link', 'add', '--url', 'https://example.com', '--project', DIR)
    wait_until(lambda: app.settings().get('links', {}).get(DIR), 5, 'lien enregistré')
    app.click('button', 'Retirer des favoris')
    wait_until(lambda: app.settings().get('favorites') == [], 5, 'favori retiré')
    assert app.settings()['links'][DIR][0]['url'] == 'https://example.com'


@pytest.mark.skipif(shutil.which('zellij') is None, reason='zellij absent')
def test_terminal_demarre_par_la_cli(run_app):
    _, app = project(run_app)
    app.ocg('terminal', 'add', '--name', 'serveur', '--command', 'sleep 600', '--start', '--project', DIR)
    app.find(None, 'Arrêter', timeout=20)
    app.ocg('terminal', 'stop', 'serveur', '--project', DIR)
    wait_until(lambda: not app.has(None, 'Arrêter'), 20, 'terminal arrêté')


def test_tache_ajoutee_par_la_cli(run_app):
    _, app = project(run_app)
    app.ocg('task', 'add', '--name', 'Point', '--dir', DIR, '--manual', '--prompt', 'Fais le point.')
    app.find('list item', contains='Point')
