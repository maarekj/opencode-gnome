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


# ---------------------------------------------------------------- revue commentée (#125)

PATCH2 = 'diff --git a/lib.txt b/lib.txt\n--- a/lib.txt\n+++ b/lib.txt\n@@ -3,1 +3,2 @@\n ligne trois\n+ajout dans lib\n'


def review_data(repo: Path) -> dict:
    data = data_for(repo)
    data['vcsDiff'].append({'file': 'lib.txt', 'status': 'modified', 'additions': 1, 'deletions': 0, 'patch': PATCH2})
    return data


def comment_all(app, text: str) -> None:
    """Sélectionne tout le diff affiché et le commente."""
    view = app.find('text', None, within=app.find('frame', 'Git — depot'))
    app._point(view, 'b1c')
    app.key('<Control>a')
    app.click('button', 'Commenter la sélection')
    app.dialog()
    app.type(text)
    app.click('button', 'Enregistrer')


def test_revue_commentee_envoyee_a_l_agent(run_app, repo):
    fake, app = run_app(review_data(repo), '--session', 'ses_g')
    app.click('button', 'Git : modifications, journal, branches')
    app.find('list item', 'Modifié : app.txt')
    comment_all(app, 'Pourquoi non commité ?')
    app.click('list item', 'Modifié : lib.txt')
    assert app.text_visible('ajout dans lib')
    comment_all(app, 'Renommer cette ligne')
    app.find('toggle button', 'Revue commentée')
    assert app.text_visible('Revue · 2 commentaires')
    app.click('button', 'Envoyer à l’agent')
    body = fake.wait_request('POST', '/session/ses_g/prompt_async')['body']
    text = body['parts'][0]['text']
    assert '2 commentaires sur 2 fichiers' in text
    assert 'app.txt — lignes 1–2 (modifications non commitées)' in text
    assert '+non commité' in text and 'Pourquoi non commité ?' in text
    assert 'lib.txt — lignes 3–4' in text and '+ajout dans lib' in text and 'Renommer cette ligne' in text
    # revue conservée après l'envoi (vérification de ce que l'agent a fait)
    assert app.text_visible('Revue · 2 commentaires')


def test_revue_brouillon_conserve(run_app, repo):
    _, app = run_app(review_data(repo), '--session', 'ses_g')
    app.click('button', 'Git : modifications, journal, branches')
    app.find('list item', 'Modifié : app.txt')
    comment_all(app, 'À revoir')
    app.key('Escape')
    wait_until(lambda: not app.has('frame', 'Git — depot'), 5, 'fenêtre fermée')
    app.click('button', 'Git : modifications, journal, branches')
    # rouvert : brouillon retrouvé, panneau affiché
    assert app.text_visible('Revue · 1 commentaire')
    assert app.text_visible('À revoir')


def nested_diff() -> list:
    def d(path, add, rem):
        return {'file': path, 'status': 'modified', 'additions': add, 'deletions': rem, 'patch': f'diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1,1 +1,1 @@\n-ancien {path}\n+nouveau {path}\n'}

    return [d('src/app/main.ts', 3, 1), d('src/app/view.ts', 2, 0), d('src/shared/util.ts', 1, 1), d('README.md', 1, 0)]


def test_arborescence_des_fichiers(run_app, repo):
    data = data_for(repo)
    data['vcsDiff'] = nested_diff()
    _, app = run_app(data)
    app.click('list item', 'depot')
    app.click('button', 'Git : modifications, journal, branches, comparaison')
    win = app.find('frame', 'Git — depot')
    app.find('list item', 'Modifié : src/app/main.ts', within=win)
    # bascule en arborescence : dossiers dépliables, choix mémorisé
    app.click('radio button', 'Arborescence des dossiers', within=win)
    app.find('list item', 'src/app/ — replier', within=win)
    app.find('list item', 'src/shared/ — replier', within=win)
    wait_until(lambda: app.settings().get('gitFilesTree') is True, 5, 'choix mémorisé')
    # repli d'un dossier : ses fichiers disparaissent
    app._point(app.find('list item', 'src/app/ — replier', within=win), 'b1c')
    app.find('list item', 'src/app/ — déplier', within=win)
    wait_until(lambda: not app.has('list item', 'Modifié : src/app/view.ts'), 5, 'fichiers du dossier masqués')
    # rafraîchissement : le dossier reste replié (même s'il contient le fichier affiché)
    app.click('button', 'Rafraîchir (F5)', within=win)
    time.sleep(1)
    app.find('list item', 'src/app/ — déplier', within=win)
    # fichier choisi dans l'arborescence : son diff
    app._point(app.find('list item', 'Modifié : src/shared/util.ts', within=win), 'b1c')
    assert app.text_visible('nouveau src/shared/util.ts')
    # retour à plat
    app.click('radio button', 'Liste à plat', within=win)
    app.find('list item', 'Modifié : src/app/view.ts', within=win)
    wait_until(lambda: app.settings().get('gitFilesTree') is False, 5, 'choix mémorisé')


def test_arborescence_memorisee(run_app, repo):
    data = data_for(repo)
    data['vcsDiff'] = nested_diff()
    _, app = run_app(data, settings={'gitFilesTree': True})
    app.click('list item', 'depot')
    app.click('button', 'Git : modifications, journal, branches, comparaison')
    win = app.find('frame', 'Git — depot')
    app.find('list item', 'src/app/ — replier', within=win)
