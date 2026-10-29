"""Terminaux persistants (zellij), terminaux intégrés (VTE), liens épinglés et IDE.

zellij tourne dans le dossier d'exécution privé du test : ses sessions ne sont pas celles de
l'utilisateur. Liens, terminaux externes et IDE sont journalisés par le bac à sable.
"""

import os
import shutil
import subprocess
import time

import pytest
from conftest import Atspi, scenario, wait_until

DIR = '/tmp/opencode-fake/demo'


def project(run_app, **kw):
    fake, app = run_app(scenario('composer'), **kw)
    app.click('list item', 'demo')
    app.find('button', 'Nouvelle session')
    return fake, app


def fill(app, dialog, values: list[str]) -> None:
    fields = [n for n in dialog.findChildren(lambda n: n.roleName == 'text' and n.showing and n.getState().contains(Atspi.StateType.EDITABLE))]
    for field, value in zip(fields, values):
        field.text = value


def terminals(app) -> list:
    return app.settings().get('terminals', {}).get(DIR, [])


def links(app) -> list:
    return app.settings().get('links', {}).get(DIR, [])


# ---------------------------------------------------------------- terminaux persistants

needs_zellij = pytest.mark.skipif(shutil.which('zellij') is None, reason='zellij absent')


def add_terminal(app, name='Serveur', command='sleep 600'):
    app.click('button', contains='Ajouter un terminal persistant')
    dialog = app.find('alert', 'Nouveau terminal')
    fill(app, dialog, [name, command])
    app.click('button', 'Ajouter', within=dialog)
    return wait_until(lambda: terminals(app)[:1], 5, 'terminal enregistré')[0]


def test_ajouter_un_terminal(run_app):
    _, app = project(run_app)
    t = add_terminal(app)
    assert t['name'] == 'Serveur' and t['command'] == 'sleep 600'
    btn = app.find('button', contains='Serveur')
    assert 'Arrêté' in (btn.description or btn.name)


@needs_zellij
def test_demarrer_puis_arreter_un_terminal(run_app):
    _, app = project(run_app)
    add_terminal(app)
    app.menu(app.find('button', contains='Serveur'), 'Démarrer en arrière-plan')
    # en cours : point « En cours », boutons Redémarrer / Arrêter, ligne sous le projet
    app.find(None, 'Arrêter', timeout=20)
    app.find('list item', contains='Serveur')
    app.click(None, 'Arrêter')
    wait_until(lambda: not app.has(None, 'Arrêter'), 20, 'terminal arrêté')


def test_modifier_puis_supprimer_un_terminal(run_app):
    _, app = project(run_app)
    add_terminal(app)
    app.menu(app.find('button', contains='Serveur'), 'Modifier…')
    dialog = app.find('alert', 'Modifier le terminal')
    fill(app, dialog, ['Tests', 'pnpm test --watch'])
    app.click('button', 'Enregistrer', within=dialog)
    wait_until(lambda: terminals(app)[0]['name'] == 'Tests', 5, 'terminal modifié')
    app.menu(app.find('button', contains='Tests'), 'Supprimer…')
    dialog = app.find('alert', 'Supprimer le terminal ?')
    app.click('button', 'Supprimer', within=dialog)
    wait_until(lambda: terminals(app) == [], 5, 'terminal supprimé')


# ---------------------------------------------------------------- terminaux intégrés

def test_panneau_de_terminaux_integres(run_app):
    _, app = project(run_app)
    app.key('<Control><Shift>j')
    app.click('button', 'Nouveau shell (dossier de la session ou du projet)')
    app.find('page tab', contains='Shell')
    app.click('button', 'Agrandir le panneau')
    app.find('button', 'Réduire le panneau')
    app.click('button', 'Ouvrir l’onglet dans le terminal externe')
    assert app.logged('TERMINAL', DIR)
    app.click('button', 'Masquer le panneau (Ctrl+Maj+J)')
    wait_until(lambda: not app.has('button', 'Nouveau shell (dossier de la session ou du projet)'), 5, 'panneau masqué')


def test_session_attachee_dans_un_onglet(run_app):
    _, app = run_app(scenario('composer'), '--session', 'ses_a')
    app.click('button', 'Ouvrir la session dans un terminal (opencode attach)')
    app.find('page tab', contains='Corriger le bug de connexion')


def test_terminal_externe_si_le_terminal_integre_est_desactive(run_app):
    _, app = run_app(scenario('composer'), '--session', 'ses_a', settings={'terminalIntegrated': False})
    app.click('button', contains='Ouvrir la session dans le terminal externe')
    assert app.logged('TERMINAL', 'opencode attach')


# ---------------------------------------------------------------- liens

def add_link(app, name: str, url: str):
    app.click('button', contains='Épingler un lien')
    dialog = app.find('alert', 'Nouveau lien')
    fill(app, dialog, [name, url])
    return dialog


def test_epingler_et_ouvrir_un_lien(run_app):
    _, app = project(run_app)
    dialog = add_link(app, 'Admin', 'localhost:8080/admin')
    app.find(None, contains='http://localhost:8080/admin', within=dialog)
    app.click('button', 'Ajouter', within=dialog)
    wait_until(lambda: links(app)[:1], 5, 'lien enregistré')
    app.click('button', contains='Admin')
    assert app.logged('LIEN', 'http://localhost:8080/admin')


def test_lien_avec_variable_direnv(run_app):
    d = '/tmp/opencode-fake/demo'
    with open(f'{d}/.envrc', 'w') as f:
        f.write('export PORT_WEB=4321\n')
    fake, app = project(run_app)
    # autorisation direnv dans les données privées du test (XDG_DATA_HOME)
    subprocess.run(['direnv', 'allow', d], env={**os.environ, 'XDG_DATA_HOME': str(fake.dir / 'data'), 'XDG_CONFIG_HOME': str(fake.dir / 'config')}, check=True, timeout=10)
    try:
        dialog = add_link(app, 'Web', 'localhost:$PORT_WEB/admin')
        app.find(None, contains='http://localhost:4321/admin', within=dialog, timeout=15)
    finally:
        os.remove(f'{d}/.envrc')


def test_copier_modifier_supprimer_un_lien(run_app):
    _, app = project(run_app, settings={'links': {DIR: [{'id': 'l1', 'name': 'Docs', 'url': 'https://example.com/docs'}]}})
    btn = app.find('button', contains='Docs')
    app.menu(btn, 'Copier l’adresse')
    wait_until(lambda: app.clipboard() == 'https://example.com/docs', 5, 'adresse copiée')
    app.menu(app.find('button', contains='Docs'), 'Modifier…')
    dialog = app.find('alert', 'Modifier le lien')
    fill(app, dialog, ['Documentation'])
    app.click('button', 'Enregistrer', within=dialog)
    wait_until(lambda: links(app)[0]['name'] == 'Documentation', 5, 'lien renommé')
    app.menu(app.find('button', contains='Documentation'), 'Supprimer…')
    dialog = app.find('alert', 'Supprimer le lien ?')
    app.click('button', 'Supprimer', within=dialog)
    wait_until(lambda: links(app) == [], 5, 'lien supprimé')


# ---------------------------------------------------------------- IDE

def test_ouvrir_dans_l_ide(run_app):
    _, app = project(run_app)
    if not app.has(None, contains='Ouvrir le projet dans'):
        pytest.skip('aucun IDE installé')
    node = app.find(None, contains='Ouvrir le projet dans')
    btn = node if 'click' in node.actions else node.findChild(lambda n: 'click' in n.actions, retry=False)
    btn.doActionNamed('click')
    assert app.logged('IDE', DIR)


# ---------------------------------------------------------------- ordre (glisser-déposer, #144)


def drag(app, src, dst, right: bool) -> None:
    """Glisse le nœud `src` sur la moitié gauche (ou droite) de `dst`, par petits pas."""
    from conftest import _OFFSET

    dx, dy = _OFFSET or (0, 0)
    a = src.get_extents(Atspi.CoordType.WINDOW)
    b = dst.get_extents(Atspi.CoordType.WINDOW)
    y = a.y + a.height // 2 + dy
    x0 = a.x + a.width // 2 + dx
    x1 = b.x + (b.width * 3 // 4 if right else b.width // 4) + dx
    subprocess.run(['xdotool', 'mousemove', str(x0), str(y), 'mousedown', '1'], check=True)
    for step in range(1, 16):
        subprocess.run(['xdotool', 'mousemove', str(x0 + (x1 - x0) * step // 15), str(y)], check=True)
        time.sleep(0.05)
    subprocess.run(['xdotool', 'mouseup', '1'], check=True)


def test_reordonner_les_terminaux(run_app):
    names = ['un', 'deux', 'trois']
    settings = {'terminals': {DIR: [{'id': f't{i}', 'name': n, 'command': 'sleep 600'} for i, n in enumerate(names)]}}
    _, app = project(run_app, settings=settings)
    # « un » déposé sur la moitié droite de « deux » : après lui
    drag(app, app.find('button', contains='un'), app.find('button', contains='deux'), right=True)
    wait_until(lambda: [t['name'] for t in terminals(app)] == ['deux', 'un', 'trois'], 5, 'ordre enregistré')
    # un simple clic ouvre toujours le terminal (pas de glisser)
    assert app.find('button', contains='trois')


def test_reordonner_les_liens(run_app):
    names = ['alpha', 'beta', 'gamma']
    settings = {'links': {DIR: [{'id': f'l{i}', 'name': n, 'url': f'localhost:{3000 + i}'} for i, n in enumerate(names)]}}
    _, app = project(run_app, settings=settings)
    # « gamma » déposé sur la moitié gauche d'« alpha » : en tête
    drag(app, app.find('button', 'gamma'), app.find('button', 'alpha'), right=False)
    wait_until(lambda: [l['name'] for l in links(app)] == ['gamma', 'alpha', 'beta'], 5, 'ordre enregistré')
    app.click('button', 'beta')
    assert app.logged('LIEN', 'localhost:3001')
