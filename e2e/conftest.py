"""Harnais des tests de bout en bout : un faux opencode et l'application par test.

Lancé par `pnpm e2e` (écran virtuel, bus D-Bus et bus d'accessibilité privés : voir
scripts/e2e.ts). L'application est pilotée par l'accessibilité (dogtail) : les widgets sont
trouvés par rôle et nom (texte affiché ou infobulle), jamais par coordonnées.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

import pytest

# dogtail exige le réglage « accessibilité activée » : posé dans un GSettings en mémoire
# (GSETTINGS_BACKEND=memory, cf. scripts/e2e.ts), jamais dans le dconf de l'utilisateur
assert os.environ.get('GSETTINGS_BACKEND') == 'memory', 'lancer via `pnpm e2e` (GSettings en mémoire)'
import gi  # noqa: E402

gi.require_version('Gio', '2.0')
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio  # noqa: E402

Gio.Settings.new('org.gnome.desktop.interface').set_boolean('toolkit-accessibility', True)

from dogtail import tree  # noqa: E402
from dogtail.config import config

ROOT = Path(__file__).resolve().parent.parent
SCENARIOS = Path(__file__).resolve().parent / 'scenarios'

config.logDebugToFile = False
config.logDebugToStdOut = False
config.searchCutoffCount = 10
config.searchBackoffDuration = 0.3
config.actionDelay = 0.3
config.defaultDelay = 0.3


def free_port() -> int:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def wait_until(check, timeout: float = 10, what: str = 'condition'):
    """Attend que `check()` renvoie une valeur vraie ; échec explicite après `timeout` s."""
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        try:
            last = check()
            if last:
                return last
        except Exception as e:  # noqa: BLE001 — nœud pas encore présent
            last = e
        time.sleep(0.2)
    raise AssertionError(f'délai dépassé : {what} (dernier résultat : {last!r})')


class Fake:
    """Faux serveur opencode (scripts/fake-opencode.ts)."""

    def __init__(self, scenario: dict | None) -> None:
        self.port = free_port()
        self.url = f'http://127.0.0.1:{self.port}'
        self.dir = Path(tempfile.mkdtemp(prefix='og-e2e-'))
        args = ['node', str(ROOT / 'scripts' / 'fake-opencode.ts'), '--port', str(self.port)]
        if scenario is not None:
            path = self.dir / 'scenario.json'
            path.write_text(json.dumps(scenario))
            args += ['--scenario', str(path)]
        self.proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        wait_until(lambda: self._get('/global/health'), 10, 'démarrage du faux opencode')

    def _get(self, path: str):
        with urllib.request.urlopen(self.url + path, timeout=2) as r:
            return json.loads(r.read() or b'null')

    def post(self, path: str, body: object) -> None:
        req = urllib.request.Request(self.url + path, data=json.dumps(body).encode(), headers={'content-type': 'application/json'}, method='POST')
        urllib.request.urlopen(req, timeout=2).read()

    def requests(self, method: str | None = None, path: str | None = None) -> list[dict]:
        """Requêtes reçues de l'application (filtrées par méthode et chemin exact)."""
        return [r for r in self._get('/__test/requests') if (method is None or r['method'] == method) and (path is None or r['path'] == path)]

    def wait_request(self, method: str, path: str, timeout: float = 10) -> dict:
        return wait_until(lambda: (self.requests(method, path) or [None])[-1], timeout, f'requête {method} {path}')

    def stop(self) -> None:
        self.proc.terminate()
        self.proc.wait(5)


class App:
    """L'application, pilotée par l'accessibilité."""

    def __init__(self, fake: Fake, args: list[str]) -> None:
        env = dict(os.environ)
        env.update(
            OPENCODE_GNOME_URL=fake.url,
            # réglages isolés (sessions ouvertes, préférences) : jamais ceux de l'utilisateur
            XDG_CONFIG_HOME=str(fake.dir / 'config'),
            XDG_DATA_HOME=str(fake.dir / 'data'),
            XDG_CACHE_HOME=str(fake.dir / 'cache'),
            OPENCODE_GNOME_SANDBOX='1',
        )
        self.proc = subprocess.Popen(['gjs', '-m', str(ROOT / 'dist' / 'app' / 'main.js'), '--size', '1280x800', *args], env=env)
        self.root = wait_until(self._find_app, 15, "démarrage de l'application")
        # premier rendu : la liste des projets est chargée
        wait_until(lambda: self.root.findChildren(lambda n: n.roleName == 'list item'), 15, 'chargement des projets')

    def _find_app(self):
        for a in tree.root.children:
            try:
                if a.name == 'gjs' and a.get_process_id() == self.proc.pid:
                    return a
            except Exception:  # noqa: BLE001
                continue
        return None

    # ---------------------------------------------------------------- recherche

    def find(self, role: str | None = None, name: str | None = None, *, contains: str | None = None, timeout: float = 10, showing: bool = True):
        """Premier nœud visible du rôle et du nom (exact, ou contenant `contains`)."""

        def match(n) -> bool:
            if role is not None and n.roleName != role:
                return False
            if name is not None and n.name != name:
                return False
            if contains is not None and contains not in (n.name or ''):
                return False
            return not showing or n.showing

        return wait_until(lambda: self.root.findChild(match, retry=False, requireResult=False), timeout, f'{role or "nœud"} « {name or contains} »')

    def has(self, role: str | None = None, name: str | None = None, *, contains: str | None = None) -> bool:
        try:
            self.find(role, name, contains=contains, timeout=0.5)
            return True
        except AssertionError:
            return False

    def text_visible(self, text: str, timeout: float = 10) -> bool:
        """Un texte (label, ou contenu d'une vue de texte) contenant `text` est affiché."""

        def check() -> bool:
            for n in self.root.findChildren(lambda n: n.roleName in ('label', 'text') and n.showing, recursive=True):
                try:
                    content = n.name if n.roleName == 'label' else n.text
                except Exception:  # noqa: BLE001
                    content = n.name
                if text in (content or ''):
                    return True
            return False

        return bool(wait_until(check, timeout, f'texte « {text} » affiché'))

    # ---------------------------------------------------------------- actions

    def click(self, role: str | None = None, name: str | None = None, *, contains: str | None = None, timeout: float = 10):
        """Active un widget par son action d'accessibilité (indépendant des coordonnées)."""
        node = self.find(role, name, contains=contains, timeout=timeout)
        if 'click' in node.actions:
            node.doActionNamed('click')
        else:
            # lignes de liste : pas d'action d'accessibilité, clic réel au centre du nœud. GTK 4
            # sous X11 ne donne pas de coordonnées écran, mais des coordonnées fenêtre ; Xvfb n'a
            # pas de gestionnaire de fenêtres : la fenêtre est en 0,0, les deux coïncident
            e = node.get_extents(Atspi.CoordType.WINDOW)
            Atspi.generate_mouse_event(e.x + e.width // 2, e.y + e.height // 2, 'b1c')
        return node

    def composer(self):
        """Zone de saisie du prompt : la vue de texte éditable (les messages ne le sont pas)."""
        return wait_until(
            lambda: self.root.findChild(lambda n: n.roleName == 'text' and n.showing and n.getState().contains(Atspi.StateType.EDITABLE), retry=False, requireResult=False),
            10,
            'compositeur',
        )

    def type_in_composer(self, text: str) -> None:
        """Saisit `text` dans le compositeur puis l'envoie (Ctrl+Entrée)."""
        composer = self.composer()
        # interface « texte éditable » : saisie sans dépendre du focus clavier
        composer.text = text
        wait_until(lambda: composer.text == text, 5, 'texte saisi dans le compositeur')
        self.click('button', contains='Envoyer')

    def stop(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def scenario(name: str) -> dict:
    return json.loads((SCENARIOS / f'{name}.json').read_text())


@pytest.fixture
def run_app(request):
    """`run_app(scenario, *args)` : démarre un faux opencode et l'application ; tout est arrêté après le test."""
    started: list = []

    def start(data: dict | None, *args: str) -> tuple[Fake, App]:
        fake = Fake(data)
        started.append(fake)
        app = App(fake, list(args))
        started.append(app)
        return fake, app

    yield start
    for thing in reversed(started):
        thing.stop()
