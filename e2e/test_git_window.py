"""Fenêtre git : modifications (serveur), journal, branches et comparaison (dépôt git temporaire)."""

import tempfile
import time
from pathlib import Path

import pytest
from conftest import wait_until
from gitrepo import git, make_repo

PATCH = 'diff --git a/app.txt b/app.txt\n--- a/app.txt\n+++ b/app.txt\n@@ -1,1 +1,2 @@\n main 2\n+non commité\n'


def data_for(repo: Path, diff: bool = True) -> dict:
    return {
        'projects': [{'id': 'prj_g', 'worktree': str(repo), 'name': 'depot', 'vcs': 'git'}],
        'sessions': [{'id': 'ses_g', 'projectID': 'prj_g', 'directory': str(repo), 'title': 'Session git', 'time': {'created': 1, 'updated': 2}}],
        'messages': {'ses_g': [{'info': {'id': 'msg_1', 'role': 'user', 'sessionID': 'ses_g', 'time': {'created': 1792900000000}}, 'parts': [{'id': 'prt_1', 'type': 'text', 'messageID': 'msg_1', 'sessionID': 'ses_g', 'text': 'Travail sur le dépôt'}]}]},
        'vcsDiff': [{'file': 'app.txt', 'status': 'modified', 'additions': 1, 'deletions': 0, 'patch': PATCH}] if diff else [],
    }


@pytest.fixture
def repo():
    return make_repo(Path(tempfile.mkdtemp(prefix='og-git-')) / 'depot')


def open_git(run_app, repo, **kw):
    fake, app = run_app(data_for(repo, **kw))
    app.click('list item', 'depot')
    app.click('button', 'Git : modifications, journal, branches, comparaison')
    app.find('frame', 'Git — depot')
    return fake, app


def tab(app, name: str) -> None:
    app.click('page tab', name)


def test_modifications_et_diff(run_app, repo):
    _, app = open_git(run_app, repo)
    app.find('list item', 'Modifié : app.txt')
    app.find('label', '+1 −0')
    assert app.text_visible('non commité')


def test_aucune_modification(run_app, repo):
    _, app = open_git(run_app, repo, diff=False)
    assert app.text_visible('Aucune modification')


def test_f5_et_rafraichissement_automatique(run_app, repo):
    # ouverte depuis la conversation : suit les modifications de fichiers de la session
    fake, app = run_app(data_for(repo), '--session', 'ses_g')
    app.click('button', 'Git : modifications, journal, branches')
    app.find('list item', 'Modifié : app.txt')
    n = len(fake.requests('GET', '/vcs/diff'))
    app.click('button', 'Rafraîchir (F5)')
    wait_until(lambda: len(fake.requests('GET', '/vcs/diff')) > n, 5, 'modifications relues (bouton)')
    n = len(fake.requests('GET', '/vcs/diff'))
    app.emit('session.diff', {'sessionID': 'ses_g', 'diff': []})
    wait_until(lambda: len(fake.requests('GET', '/vcs/diff')) > n, 10, 'modifications relues (session.diff)')


def test_une_seule_fenetre_et_echap(run_app, repo):
    _, app = run_app(data_for(repo), '--session', 'ses_g')
    app.click('button', 'Git : modifications, journal, branches')
    app.find('frame', 'Git — depot')
    # bouton-titre de la conversation : même fenêtre, pas une seconde
    app.find('button', contains='Session git', within=app.find('frame', 'opencode')).doActionNamed('click')
    time.sleep(0.5)
    assert len(app.all('frame', 'Git — depot')) == 1
    app.find('frame', 'Git — depot')
    app.key('Escape')
    wait_until(lambda: not app.has('frame', 'Git — depot'), 5, 'fenêtre fermée')


def test_titre_de_la_conversation_ouvre_la_fenetre(run_app, repo):
    _, app = run_app(data_for(repo), '--session', 'ses_g')
    title = app.find('button', contains='Session git')
    # sous-titre : branche lue dans le dépôt
    wait_until(lambda: 'main' in (app.find('button', contains='Session git').name or ''), 10, 'branche dans le sous-titre')
    title.doActionNamed('click')
    app.find('frame', 'Git — depot')


def test_journal_et_detail_d_un_commit(run_app, repo):
    _, app = open_git(run_app, repo)
    tab(app, 'Journal')
    app.find('label', 'Main 2')
    app.find('label', 'Fusion de feature')
    # commit le plus récent sélectionné : message complet et fichiers
    assert app.text_visible('Corps du message : détails du changement.')
    head = git(repo, 'rev-parse', 'HEAD')
    # infobulle du bouton : « Copier <identifiant> » une fois le commit chargé
    app.click('button', f'Copier {head}')
    wait_until(lambda: app.clipboard() == head, 5, 'identifiant copié')


def test_journal_toutes_les_branches(run_app, repo):
    _, app = open_git(run_app, repo)
    tab(app, 'Journal')
    app.find('label', 'Main 2')
    assert not app.has('label', 'WIP en cours')
    app.click('toggle button', 'Toutes les branches')
    app.find('label', 'WIP en cours')


def test_journal_afficher_plus(run_app):
    big = make_repo(Path(tempfile.mkdtemp(prefix='og-git-')) / 'depot', extra_commits=310)
    _, app = open_git(run_app, big)
    tab(app, 'Journal')
    app.find('label', 'Commit vide 309')
    assert not app.has('label', 'Initial')
    app.click('button', 'Afficher plus')
    app.find('label', 'Initial', timeout=15)


def test_branches_et_journal_d_une_branche(run_app, repo):
    _, app = open_git(run_app, repo)
    tab(app, 'Branches')
    app.find('label', 'Branches locales (3)')
    app.find('label', 'Tags (1)')
    app.click('list item', 'Voir le journal de wip')
    app.find('label', 'WIP en cours')
    app.click('button', 'Revenir à la branche actuelle')
    wait_until(lambda: not app.has('label', 'WIP en cours'), 5, 'retour à main')


def test_comparer_depuis_les_branches(run_app, repo):
    _, app = open_git(run_app, repo)
    tab(app, 'Branches')
    app.click('button', 'Comparer wip avec la branche actuelle')
    app.find('label', 'main → wip')
    app.find('label', 'Seulement dans wip (1)')
    app.find('label', 'WIP en cours')


def compare(app, base: str, other: str) -> None:
    tab(app, 'Comparer')
    entries = wait_until(lambda: [n for n in app.all('text') if n.getState().contains(__import__('conftest').Atspi.StateType.EDITABLE)][:2], 5, 'champs de comparaison')
    entries[0].text = base
    entries[1].text = other
    app.click('button', 'Comparer', within=app.find('frame', 'Git — depot'))


def test_comparer_deux_commits_en_difference_directe(run_app, repo):
    _, app = open_git(run_app, repo)
    first = git(repo, 'rev-list', '--max-parents=0', 'HEAD')[:7]
    compare(app, first, 'feature')
    app.find('label', f'{first} → feature')
    app.find('label', 'Seulement dans feature (2)')


def test_inverser(run_app, repo):
    _, app = open_git(run_app, repo)
    compare(app, 'main', 'wip')
    app.find('label', 'main → wip')
    app.click('button', 'Inverser')
    app.find('label', 'wip → main')


def test_reference_introuvable(run_app, repo):
    _, app = open_git(run_app, repo)
    compare(app, 'main', 'nexistepas')
    assert app.text_visible('Comparaison impossible')
    assert app.text_visible('Référence introuvable : nexistepas')


def test_comparer_un_commit_du_journal(run_app, repo):
    _, app = open_git(run_app, repo)
    tab(app, 'Journal')
    app.find('label', 'Main 2')
    app.click('button', 'Comparer ce commit avec la branche actuelle')
    app.find('label', contains='→ HEAD')
