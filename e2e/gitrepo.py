"""Dépôt git temporaire pour les tests de la fenêtre git (journal, branches, comparaison)."""

import subprocess
from pathlib import Path

ENV = {'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 't@example.invalid', 'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 't@example.invalid', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_SYSTEM': '/dev/null'}


def git(repo: Path, *args: str) -> str:
    import os

    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True, env={**os.environ, **ENV}).stdout.strip()


def commit(repo: Path, name: str, line: str, message: str) -> None:
    f = repo / name
    f.write_text((f.read_text() if f.exists() else '') + line + '\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', message)


def make_repo(path: Path, extra_commits: int = 0) -> Path:
    """main : Initial, Base, (fusion de feature), Main 2 ; feature : Feature 1 ; wip : WIP (non fusionnée) ; tag v1.0."""
    path.mkdir(parents=True, exist_ok=True)
    git(path, 'init', '-q', '-b', 'main')
    commit(path, 'app.txt', 'initial', 'Initial')
    commit(path, 'app.txt', 'base', 'Base')
    git(path, 'switch', '-qc', 'feature')
    commit(path, 'feature.txt', 'feature 1', 'Feature 1')
    git(path, 'switch', '-q', 'main')
    commit(path, 'app.txt', 'main 1', 'Main 1')
    git(path, 'merge', '-q', '--no-ff', 'feature', '-m', 'Fusion de feature')
    git(path, 'tag', 'v1.0')
    commit(path, 'app.txt', 'main 2', 'Main 2\n\nCorps du message : détails du changement.')
    git(path, 'switch', '-qc', 'wip')
    commit(path, 'wip.txt', 'wip', 'WIP en cours')
    git(path, 'switch', '-q', 'main')
    for i in range(extra_commits):
        git(path, 'commit', '-q', '--allow-empty', '-m', f'Commit vide {i}')
    (path / 'app.txt').write_text((path / 'app.txt').read_text() + 'non commité\n')
    return path
