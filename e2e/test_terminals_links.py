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


def add_menu(app, entry: str) -> None:
    """Bouton « + » de la barre du projet, puis l'entrée `entry` de son menu."""
    app.click('toggle button', contains='Ajouter un terminal, un lien ou un dossier')
    app.find('menu item', entry).doActionNamed('click')


def add_terminal(app, name='Serveur', command='sleep 600'):
    add_menu(app, 'Nouveau terminal persistant…')
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
    add_menu(app, 'Nouveau lien…')
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


def order(app) -> list[str]:
    """Disposition de la barre du projet (clés), dossiers avec leur contenu entre crochets."""
    out = []
    for e in app.settings().get('layout', {}).get(DIR, []):
        if 'folder' in e:
            inner = ','.join(f"{k}:{i[k]}" for i in e['items'] for k in ('terminal', 'link', 'devenv') if k in i)
            out.append(f"{e['name']}[{inner}]")
        else:
            kind = 'terminal' if 'terminal' in e else 'devenv' if 'devenv' in e else 'link'
            out.append(f'{kind}:{e[kind]}')
    return out


def test_reordonner_les_terminaux(run_app):
    names = ['un', 'deux', 'trois']
    settings = {'terminals': {DIR: [{'id': f't{i}', 'name': n, 'command': 'sleep 600'} for i, n in enumerate(names)]}}
    _, app = project(run_app, settings=settings)
    # « un » déposé sur la moitié droite de « deux » : après lui
    drag(app, app.find('button', contains='un'), app.find('button', contains='deux'), right=True)
    wait_until(lambda: order(app) == ['terminal:t1', 'terminal:t0', 'terminal:t2'], 5, 'ordre enregistré')
    # un simple clic ouvre toujours le terminal (pas de glisser)
    assert app.find('button', contains='trois')


def test_reordonner_les_liens(run_app):
    names = ['alpha', 'beta', 'gamma']
    settings = {'links': {DIR: [{'id': f'l{i}', 'name': n, 'url': f'localhost:{3000 + i}'} for i, n in enumerate(names)]}}
    _, app = project(run_app, settings=settings)
    # « gamma » déposé sur la moitié gauche d'« alpha » : en tête
    drag(app, app.find('button', 'gamma'), app.find('button', 'alpha'), right=False)
    wait_until(lambda: order(app) == ['link:l2', 'link:l0', 'link:l1'], 5, 'ordre enregistré')
    app.click('button', 'beta')
    assert app.logged('LIEN', 'localhost:3001')


# ---------------------------------------------------------------- barre mélangée et dossiers (#145)


def test_melanger_terminaux_et_liens_et_ranger_dans_un_dossier(run_app):
    settings = {
        'terminals': {DIR: [{'id': 't0', 'name': 'serveur', 'command': 'sleep 600'}]},
        'links': {DIR: [{'id': 'l0', 'name': 'admin', 'url': 'localhost:3000'}]},
        'layout': {DIR: [{'terminal': 't0'}, {'link': 'l0'}, {'folder': 'f1', 'name': 'worktree 1', 'items': []}]},
    }
    _, app = project(run_app, settings=settings)
    # lien glissé avant le terminal : mélangés dans la même barre
    drag(app, app.find('button', 'admin'), app.find('button', contains='serveur'), right=False)
    wait_until(lambda: order(app)[:2] == ['link:l0', 'terminal:t0'], 5, 'lien avant le terminal')
    # terminal déposé au milieu du dossier : rangé dedans
    folder = app.find('toggle button', contains='Dossier « worktree 1 »')
    drag_into(app, app.find('button', contains='serveur'), folder)
    wait_until(lambda: order(app) == ['link:l0', 'worktree 1[terminal:t0]'], 5, 'terminal dans le dossier')
    # menu du dossier : le terminal y est ; « Sortir du dossier » par son menu contextuel
    app.click('toggle button', contains='Dossier « worktree 1 »')
    row = app.find('button', 'serveur')
    app.menu(row, 'Sortir du dossier')
    wait_until(lambda: order(app) == ['link:l0', 'worktree 1[]', 'terminal:t0'], 5, 'sorti du dossier')


def drag_into(app, src, dst) -> None:
    """Glisse `src` au milieu de `dst` (dossier)."""
    from conftest import _OFFSET

    dx, dy = _OFFSET or (0, 0)
    a = src.get_extents(Atspi.CoordType.WINDOW)
    b = dst.get_extents(Atspi.CoordType.WINDOW)
    y = a.y + a.height // 2 + dy
    x0 = a.x + a.width // 2 + dx
    x1 = b.x + b.width // 2 + dx
    subprocess.run(['xdotool', 'mousemove', str(x0), str(y), 'mousedown', '1'], check=True)
    for step in range(1, 16):
        subprocess.run(['xdotool', 'mousemove', str(x0 + (x1 - x0) * step // 15), str(y)], check=True)
        time.sleep(0.05)
    subprocess.run(['xdotool', 'mouseup', '1'], check=True)


def test_creer_renommer_supprimer_un_dossier(run_app):
    settings = {'links': {DIR: [{'id': 'l0', 'name': 'admin', 'url': 'localhost:3000'}]}}
    _, app = project(run_app, settings=settings)
    add_menu(app, 'Nouveau dossier…')
    dialog = app.find('alert', 'Nouveau dossier')
    fill(app, dialog, ['utilitaires'])
    app.click('button', 'Créer', within=dialog)
    wait_until(lambda: order(app) == ['link:l0', 'utilitaires[]'], 5, 'dossier créé')
    # lien rangé par son menu contextuel
    app.menu(app.find('button', 'admin'), 'Déplacer dans « utilitaires »')
    wait_until(lambda: order(app) == ['utilitaires[link:l0]'], 5, 'lien rangé')
    folder = app.find('toggle button', contains='Dossier « utilitaires »')
    app.menu(folder, 'Renommer…')
    dialog = app.find('alert', 'Renommer le dossier')
    fill(app, dialog, ['outils'])
    app.click('button', 'Renommer', within=dialog)
    wait_until(lambda: order(app) == ['outils[link:l0]'], 5, 'dossier renommé')
    app.menu(app.find('toggle button', contains='Dossier « outils »'), 'Supprimer le dossier…')
    dialog = app.find('alert', 'Supprimer le dossier ?')
    app.click('button', 'Supprimer', within=dialog)
    # contenu remis dans la barre
    wait_until(lambda: order(app) == ['link:l0'], 5, 'dossier supprimé')


@needs_zellij
def test_dossier_signale_un_terminal_en_cours(run_app):
    settings = {
        'terminals': {DIR: [{'id': 'og-e2e-folder', 'name': 'veille', 'command': 'sleep 600'}]},
        'layout': {DIR: [{'folder': 'f1', 'name': 'worktree 1', 'items': [{'terminal': 'og-e2e-folder'}]}]},
        'terminalIntegrated': False,
    }
    _, app = project(run_app, settings=settings)
    app.find('toggle button', contains='Dossier « worktree 1 » : 1 élément')
    app.click('toggle button', contains='Dossier « worktree 1 »')
    app.click('button', 'veille')
    # terminal démarré : la pastille du dossier le signale
    app.find('toggle button', contains='1 terminal en cours', timeout=20)


# ---------------------------------------------------------------- menu d'un dossier (#146)

FOLDER = {
    'links': {DIR: [{'id': f'l{i}', 'name': n, 'url': f'localhost:{3000 + i}'} for i, n in enumerate(['alpha', 'beta', 'gamma'])]},
    'layout': {DIR: [{'folder': 'f1', 'name': 'outils', 'items': [{'link': 'l0'}, {'link': 'l1'}, {'link': 'l2'}]}]},
}


def test_modifier_un_lien_depuis_le_menu_d_un_dossier(run_app):
    _, app = project(run_app, settings=FOLDER)
    app.click('toggle button', contains='Dossier « outils »')
    app.menu(app.find('button', 'beta'), 'Modifier…')
    dialog = app.find('alert', 'Modifier le lien')
    # menu du dossier fermé : le dialogue a le focus clavier (champ Nom), la saisie y arrive
    wait_until(lambda: not app.has('button', 'alpha'), 5, 'menu du dossier fermé')
    app.key('<Control>a')
    app.type('bêta')
    app.click('button', 'Enregistrer', within=dialog)
    wait_until(lambda: [l['name'] for l in links(app)] == ['alpha', 'bêta', 'gamma'], 5, 'lien renommé au clavier')


def test_reordonner_dans_le_menu_d_un_dossier(run_app):
    from conftest import _OFFSET

    _, app = project(run_app, settings=FOLDER)
    app.click('toggle button', contains='Dossier « outils »')
    src = app.find('button', 'gamma').get_extents(Atspi.CoordType.WINDOW)
    dst = app.find('button', 'alpha').get_extents(Atspi.CoordType.WINDOW)
    dx, dy = _OFFSET or (0, 0)
    x = src.x + src.width // 2 + dx
    y0 = src.y + src.height // 2 + dy
    y1 = dst.y + dst.height // 4 + dy
    # « gamma » glissé sur la moitié haute d'« alpha », sans quitter le menu (qui reste ouvert)
    subprocess.run(['xdotool', 'mousemove', str(x), str(y0), 'mousedown', '1'], check=True)
    for step in range(1, 16):
        subprocess.run(['xdotool', 'mousemove', str(x), str(y0 + (y1 - y0) * step // 15)], check=True)
        time.sleep(0.05)
    subprocess.run(['xdotool', 'mouseup', '1'], check=True)
    wait_until(lambda: order(app) == ['outils[link:l2,link:l0,link:l1]'], 5, 'ordre dans le dossier')


# ---------------------------------------------------------------- devenv (#147)


def fake_devenv(tmp_path, running: bool):
    """Dossier bin avec un faux `devenv`, son fichier d'état et l'environnement à passer à l'app."""
    import json
    import pathlib

    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir()
    (bin_dir / 'devenv').symlink_to(pathlib.Path(__file__).parent / 'fake_devenv.py')
    state = tmp_path / 'devenv.json'
    state.write_text(json.dumps({'running': running, 'processes': {'postgres': 'ready', 'web': 'ready', 'worker': 'gave_up'}}))
    env = {'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'FAKE_DEVENV_STATE': str(state)}
    return state, env


DEVENV = {'devenvs': {DIR: [{'id': 'd1', 'name': 'services'}]}}


def calls(state) -> str:
    try:
        return (state.parent / (state.name + '.log')).read_text()
    except FileNotFoundError:
        return ''


def test_devenv_services_et_actions(run_app, tmp_path):
    state, env = fake_devenv(tmp_path, running=True)
    _, app = project(run_app, settings=DEVENV, env=env)
    # pastille : un service en échec
    pill = app.find('toggle button', contains='devenv « services »')
    assert app.text_visible('1 en échec')
    app.click('toggle button', contains='devenv « services »')
    app.find('label', 'worker')
    assert app.text_visible('en échec · 5 redémarrages')
    # actions sur un service, dans le dossier du projet
    app.click('button', 'Démarrer worker')
    wait_until(lambda: f'processes start worker @ {DIR}' in calls(state), 5, 'devenv processes start worker')
    wait_until(lambda: app.has('button', 'Arrêter worker'), 10, 'worker démarré')
    app.click('button', 'Arrêter web')
    wait_until(lambda: 'processes stop web' in calls(state), 5, 'devenv processes stop web')
    app.click('button', 'Redémarrer postgres')
    wait_until(lambda: 'processes restart postgres' in calls(state), 5, 'devenv processes restart postgres')
    # logs dans une fenêtre
    app.click('button', 'Logs de postgres')
    app.find('frame', 'Logs — postgres')
    assert app.text_visible('postgres : ligne 2')
    assert pill


def test_devenv_tout_demarrer_puis_tout_arreter(run_app, tmp_path):
    state, env = fake_devenv(tmp_path, running=False)
    _, app = project(run_app, settings=DEVENV, env=env)
    assert app.text_visible('arrêté')
    app.click('toggle button', contains='devenv « services »')
    # bouton actif une fois l'état lu
    assert app.text_visible('Process manager arrêté')
    app.click('button', 'Tout démarrer')
    # sortie de devenv up affichée pendant le démarrage
    assert app.text_visible('Building shell')
    wait_until(lambda: 'up --detach --no-tui' in calls(state), 5, f'devenv up --detach : {calls(state)!r}')
    app.find('label', 'postgres', timeout=10)
    app.click('button', 'Tout arrêter')
    wait_until(lambda: 'processes down' in calls(state), 5, 'devenv processes down')
    # services retenus du démarrage : listés même arrêtés, et un seul peut être relancé
    assert app.text_visible('services du dernier démarrage')
    assert app.settings()['devenvs'][DIR][0]['services'] == ['postgres', 'web', 'worker']
    app.click('button', 'Démarrer web')
    wait_until(lambda: 'processes start web' in calls(state), 5, 'devenv processes start web')
    wait_until(lambda: app.has('button', 'Arrêter web'), 10, 'web démarré')


def test_devenv_ajoute_par_le_menu_dans_un_dossier(run_app, tmp_path):
    _, env = fake_devenv(tmp_path, running=True)
    settings = {'layout': {DIR: [{'folder': 'f1', 'name': 'worktree 1', 'items': []}]}}
    _, app = project(run_app, settings=settings, env=env)
    # depuis le menu du dossier : dossier présélectionné
    app.click('toggle button', contains='Dossier « worktree 1 »')
    app.click('button', 'devenv')
    dialog = app.find('alert', 'Nouveau devenv')
    fill(app, dialog, ['wt1', 'sous-dossier'])
    app.click('button', 'Ajouter', within=dialog)
    wait_until(lambda: app.settings().get('devenvs', {}).get(DIR), 5, 'devenv enregistré')
    did = app.settings()['devenvs'][DIR][0]['id']
    wait_until(lambda: order(app) == [f'worktree 1[devenv:{did}]'], 5, f'devenv rangé dans le dossier : {order(app)}')
    assert app.settings()['devenvs'][DIR][0]['cwd'] == 'sous-dossier'
