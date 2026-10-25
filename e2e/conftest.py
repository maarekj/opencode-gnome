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


# Décalage entre les coordonnées « fenêtre » de l'accessibilité (GTK 4 sous X11) et l'écran :
# mesuré une fois par lancement de pytest (cf. App._calibrate), 17 px avec Adwaita sous Xvfb.
_OFFSET: tuple[int, int] | None = None


class App:
    """L'application, pilotée par l'accessibilité."""

    def __init__(self, fake: Fake, args: list[str], settings: dict | None = None, env: dict | None = None) -> None:
        self.fake = fake
        self.config_dir = fake.dir / 'config' / 'opencode-gnome'
        if settings is not None:
            self.config_dir.mkdir(parents=True, exist_ok=True)
            (self.config_dir / 'settings.json').write_text(json.dumps(settings))
        self.log_path = fake.dir / 'app.log'
        extra_env = env
        env = dict(os.environ)
        env.update(
            OPENCODE_GNOME_URL=fake.url,
            # réglages isolés (sessions ouvertes, préférences) : jamais ceux de l'utilisateur
            XDG_CONFIG_HOME=str(fake.dir / 'config'),
            XDG_DATA_HOME=str(fake.dir / 'data'),
            XDG_CACHE_HOME=str(fake.dir / 'cache'),
            OPENCODE_GNOME_SANDBOX='1',
        )
        env.update(extra_env or {})
        self._log = self.log_path.open('w')
        self.proc = subprocess.Popen(['gjs', '-m', str(ROOT / 'dist' / 'app' / 'main.js'), '--size', '1280x800', *args], env=env, stdout=self._log, stderr=subprocess.STDOUT)
        self.root = wait_until(self._find_app, 15, "démarrage de l'application")
        # premier rendu : la liste des projets est chargée
        wait_until(lambda: self.root.findChildren(lambda n: n.roleName == 'list item'), 15, 'chargement des projets')
        self._calibrate()

    def _pressed(self, node) -> bool:
        st = node.getState()
        return st.contains(Atspi.StateType.CHECKED) or st.contains(Atspi.StateType.PRESSED)

    def _try(self, node, x: int, y: int) -> bool:
        """Clique en (x, y) ; vrai si la bascule `node` a changé d'état (remise ensuite dans l'état initial)."""
        Atspi.generate_mouse_event(x, y, 'b1c')
        time.sleep(0.12)
        if not self._pressed(node):
            return False
        Atspi.generate_mouse_event(x, y, 'b1c')
        wait_until(lambda: not self._pressed(node), 3, 'bascule de calibrage relâchée')
        return True

    def _calibrate(self) -> None:
        """Décalage accessibilité → écran, mesuré sur la bascule de recherche de la barre latérale."""
        global _OFFSET
        toggle = self.find('toggle button', 'Rechercher un projet (Ctrl+K)')
        e = toggle.get_extents(Atspi.CoordType.WINDOW)
        cx, cy = e.x + e.width // 2, e.y + e.height // 2
        if _OFFSET is not None and self._try(toggle, cx + _OFFSET[0], cy + _OFFSET[1]):
            return
        if self._try(toggle, cx + 17, cy + 17):
            _OFFSET = (17, 17)
            return
        # recherche des bords de la bascule (thème, échelle ou version de GTK différents)
        ys = [y for y in range(cy - 40, cy + 41, 2) if self._try(toggle, cx + 17, y)]
        assert ys, 'calibrage impossible : bascule de recherche introuvable à l\'écran'
        my = (ys[0] + ys[-1]) // 2
        xs = [x for x in range(cx - 40, cx + 41, 2) if self._try(toggle, x, my)]
        _OFFSET = ((xs[0] + xs[-1]) // 2 - cx, my - cy)

    def _find_app(self):
        for a in tree.root.children:
            try:
                if a.name == 'gjs' and a.get_process_id() == self.proc.pid:
                    return a
            except Exception:  # noqa: BLE001
                continue
        return None

    # ---------------------------------------------------------------- recherche

    def dialog(self, timeout: float = 10):
        """Dialogue (Adw.AlertDialog, Adw.Dialog) actuellement affiché."""
        return wait_until(lambda: (self.all('alert') + self.all('dialog') or [None])[-1], timeout, 'dialogue affiché')

    def find(self, role: str | None = None, name: str | None = None, *, contains: str | None = None, timeout: float = 10, showing: bool = True, within=None):
        """Premier nœud visible du rôle et du nom (exact, ou contenant `contains`), dans `within` sinon toute l'app."""
        scope = within or self.root

        def match(n) -> bool:
            if role is not None and n.roleName != role:
                return False
            if name is not None and n.name != name:
                return False
            if contains is not None and contains not in (n.name or ''):
                return False
            return not showing or n.showing

        return wait_until(lambda: scope.findChild(match, retry=False, requireResult=False), timeout, f'{role or "nœud"} « {name or contains} »')

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

    def click(self, role: str | None = None, name: str | None = None, *, contains: str | None = None, timeout: float = 10, within=None):
        """Active un widget par son action d'accessibilité (indépendant des coordonnées)."""
        node = self.find(role, name, contains=contains, timeout=timeout, within=within)
        if 'click' in node.actions:
            node.doActionNamed('click')
        else:
            # lignes de liste : pas d'action d'accessibilité, clic réel au centre du nœud
            self._point(node, 'b1c')
        return node

    def composer(self):
        """Zone de saisie du prompt : la vue de texte éditable (les messages ne le sont pas)."""
        return wait_until(
            lambda: self.root.findChild(lambda n: n.roleName == 'text' and n.showing and n.getState().contains(Atspi.StateType.EDITABLE), retry=False, requireResult=False),
            10,
            'compositeur',
        )

    def focus_composer(self):
        """Clic dans le compositeur (focus clavier), qui est renvoyé."""
        composer = self.composer()
        self._point(composer, 'b1c')
        time.sleep(0.2)
        return composer

    def combo(self, row: str, option: str, *, within=None) -> None:
        """Ligne à liste déroulante (Adw.ComboRow) : ouverture puis choix de `option`."""
        self._point(self.find('combo box', row, within=within), 'b1c')
        labels = wait_until(lambda: [n for n in self.all('label', option) if n.showing], 5, f'option « {option} »')
        self._point(labels[-1], 'b1c')

    def toggle(self, role: str, name: str, *, within=None) -> None:
        """Interrupteur (Gtk.Switch) : le nœud qui porte l'action « toggle »."""
        node = wait_until(lambda: [n for n in self.all(role, name) if 'toggle' in n.actions][:1], 5, f'{role} « {name} »')[0]
        node.doActionNamed('toggle')

    def choose(self, label: str) -> None:
        """Clic sur un libellé affiché (option d'une liste déroulante, d'une complétion)."""
        self._point(self.find('label', label), 'b1c')

    def type_in_composer(self, text: str) -> None:
        """Saisit `text` dans le compositeur puis l'envoie (Ctrl+Entrée)."""
        composer = self.composer()
        # interface « texte éditable » : saisie sans dépendre du focus clavier
        composer.text = text
        wait_until(lambda: composer.text == text, 5, 'texte saisi dans le compositeur')
        self.click('button', contains='Envoyer')

    def settings(self) -> dict:
        """Réglages enregistrés par l'application (settings.json)."""
        path = self.config_dir / 'settings.json'
        return json.loads(path.read_text()) if path.exists() else {}

    def logged(self, label: str, contains: str = '', timeout: float = 5) -> str:
        """Ligne du bac à sable (`DOSSIER …`, `LIEN …`, `TERMINAL …`) écrite par l'application."""

        def check() -> str | None:
            for line in self.log_path.read_text(errors='replace').splitlines():
                i = line.find(f'{label} ')
                if i != -1 and contains in line[i:]:
                    return line[i:]
            return None

        return wait_until(check, timeout, f'ligne « {label} {contains} » journalisée')

    def all(self, role: str, name: str | None = None, *, contains: str | None = None) -> list:
        """Tous les nœuds visibles du rôle et du nom."""
        return self.root.findChildren(
            lambda n: n.roleName == role and n.showing and (name is None or n.name == name) and (contains is None or contains in (n.name or '')),
        )

    def scroll_into_view(self, node, height: int = 800) -> None:
        """Fait défiler (molette sur le nœud) jusqu'à ce qu'il soit entièrement à l'écran."""
        dx, dy = _OFFSET or (0, 0)
        for _ in range(40):
            e = node.get_extents(Atspi.CoordType.WINDOW)
            top, bottom = e.y + dy, e.y + e.height + dy
            if top >= 0 and bottom <= height:
                return
            # molette au centre de l'écran, dans la zone défilante qui contient le nœud
            x = max(0, min(e.x + e.width // 2 + dx, 1279))
            Atspi.generate_mouse_event(x, height // 2, 'b5c' if bottom > height else 'b4c')
            time.sleep(0.05)
        raise AssertionError('nœud impossible à faire défiler à l\'écran')

    def _point(self, node, button: str) -> None:
        # GTK 4 sous X11 : pas de coordonnées écran, coordonnées fenêtre décalées (cf. _calibrate)
        self.scroll_into_view(node)
        e = node.get_extents(Atspi.CoordType.WINDOW)
        dx, dy = _OFFSET or (0, 0)
        Atspi.generate_mouse_event(e.x + e.width // 2 + dx, e.y + e.height // 2 + dy, button)

    def menu(self, node, item: str) -> None:
        """Clic droit sur `node` puis choix de l'entrée `item` dans le menu contextuel."""
        self._point(node, 'b3c')
        entry = self.find('menu item', item)
        entry.doActionNamed('click')

    def key(self, combo: str) -> None:
        """Raccourci clavier (syntaxe dogtail : '<Control>k', 'Escape', 'Return')."""
        from dogtail import rawinput

        if combo.startswith('<'):
            rawinput.keyCombo(combo)
        else:
            rawinput.pressKey(combo)

    def type(self, text: str) -> None:
        from dogtail import rawinput

        rawinput.typeText(text)

    def clipboard(self) -> str:
        """Contenu du presse-papier (écran virtuel)."""
        return subprocess.run(['xclip', '-o', '-selection', 'clipboard'], capture_output=True, text=True, timeout=5).stdout

    def emit(self, type_: str, properties: dict) -> None:
        """Événement envoyé par le faux opencode."""
        self.fake.post('/__test/emit', {'payload': {'type': type_, 'properties': properties}})

    def stop(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self._log.close()


def scenario(name: str) -> dict:
    return json.loads((SCENARIOS / f'{name}.json').read_text())


@pytest.fixture
def run_app(request):
    """`run_app(scenario, *args)` : démarre un faux opencode et l'application ; tout est arrêté après le test."""
    started: list = []

    def start(data: dict | None, *args: str, settings: dict | None = None, env: dict | None = None) -> tuple[Fake, App]:
        fake = Fake(data)
        started.append(fake)
        app = App(fake, list(args), settings, env)
        started.append(app)
        return fake, app

    yield start
    for thing in reversed(started):
        thing.stop()
