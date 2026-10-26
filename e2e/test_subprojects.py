"""Barre latérale : sous-projets rangés sous leur projet ancêtre."""

from conftest import Atspi, scenario, wait_until

C = '/tmp/opencode-fake/claude'
A = f'{C}/appartement netivot'
B = f'{C}/budget'
O = '/tmp/opencode-fake/autre'


def indent(app, name: str) -> int:
    return app.find('list item', name).get_extents(Atspi.CoordType.WINDOW).x


def order(app) -> list[str]:
    names = {'claude', 'appartement netivot', 'budget', 'autre'}
    rows = [n for n in app.all('list item') if n.name in names]
    return [n.name for n in sorted(rows, key=lambda n: n.get_extents(Atspi.CoordType.WINDOW).y)]


def test_sous_projets_sous_leur_ancetre(run_app):
    _, app = run_app(scenario('subprojects'))
    wait_until(lambda: order(app) == ['claude', 'appartement netivot', 'budget', 'autre'], 5, 'sous-projets sous claude')
    assert indent(app, 'appartement netivot') > indent(app, 'claude')
    assert indent(app, 'autre') == indent(app, 'claude')


def test_replier_le_projet_masque_ses_sous_projets(run_app):
    _, app = run_app(scenario('subprojects'))
    app.find('list item', 'budget')
    # premier bouton « Replier » : celui de claude (projet du haut)
    app.all('button', 'Replier')[0].doActionNamed('click')
    wait_until(lambda: not app.has('list item', 'budget'), 5, 'sous-projets masqués')
    app.find('list item', 'autre')
    app.click('button', 'Déplier')
    app.find('list item', 'budget')


def test_favori_en_cascade_puis_retrait_d_un_sous_projet(run_app):
    _, app = run_app(scenario('subprojects'))
    app.menu(app.find('list item', 'claude'), 'Ajouter aux favoris')
    wait_until(lambda: app.settings().get('favorites') == [C, A, B], 5, 'sous-projets mis en favoris')
    app.menu(app.find('list item', 'budget'), 'Retirer des favoris')
    wait_until(lambda: app.settings().get('favorites') == [C, A], 5, 'sous-projet retiré')
    app.click('radio button', 'Favoris')
    wait_until(lambda: order(app) == ['claude', 'appartement netivot'], 5, 'onglet Favoris')
    assert indent(app, 'appartement netivot') > indent(app, 'claude')


def test_sous_projet_favori_sans_son_parent(run_app):
    _, app = run_app(scenario('subprojects'), settings={'favorites': [O, B], 'sidebarMode': 'favorites'})
    wait_until(lambda: order(app) == ['autre', 'budget'], 5, 'favoris affichés')
    # parent absent des favoris : au premier niveau
    assert indent(app, 'budget') == indent(app, 'autre')


def test_ordre_des_sous_projets_memorise(run_app):
    _, app = run_app(scenario('subprojects'), settings={'subprojects': {C: [B, A]}})
    wait_until(lambda: order(app) == ['claude', 'budget', 'appartement netivot', 'autre'], 5, 'ordre choisi appliqué')


def test_glisser_un_sous_projet(run_app):
    import subprocess
    import time

    _, app = run_app(scenario('subprojects'))
    app.find('list item', 'budget')
    src = app.find('list item', 'budget').get_extents(Atspi.CoordType.WINDOW)
    dst = app.find('list item', 'appartement netivot').get_extents(Atspi.CoordType.WINDOW)
    from conftest import _OFFSET

    dx, dy = _OFFSET or (0, 0)
    x = src.x + src.width // 2 + dx
    # glisser « budget » sur la moitié haute d'« appartement netivot » : avant lui
    subprocess.run(['xdotool', 'mousemove', str(x), str(src.y + src.height // 2 + dy), 'mousedown', '1'], check=True)
    for step in range(1, 11):
        y = src.y + src.height // 2 + dy + (dst.y + 4 - src.y - src.height // 2) * step // 10
        subprocess.run(['xdotool', 'mousemove', str(x), str(y)], check=True)
        time.sleep(0.05)
    subprocess.run(['xdotool', 'mouseup', '1'], check=True)
    wait_until(lambda: app.settings().get('subprojects', {}).get(C) == [B, A], 5, 'ordre enregistré')
    wait_until(lambda: order(app)[:3] == ['claude', 'budget', 'appartement netivot'], 5, 'ordre affiché')
