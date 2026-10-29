#!/usr/bin/env python3
"""Faux `devenv` (process manager) pour les tests e2e : état dans $FAKE_DEVENV_STATE (JSON
{"running": bool, "processes": {nom: phase}}), chaque appel journalisé dans $FAKE_DEVENV_STATE.log."""

import json
import os
import sys

STATE = os.environ['FAKE_DEVENV_STATE']
DEFAULT = {'running': False, 'processes': {'postgres': 'ready', 'web': 'ready', 'worker': 'gave_up'}}


def load():
    try:
        with open(STATE) as f:
            return json.load(f)
    except FileNotFoundError:
        return dict(DEFAULT)


def save(s):
    with open(STATE, 'w') as f:
        json.dump(s, f)


args = sys.argv[1:]
with open(STATE + '.log', 'a') as f:
    f.write(' '.join(args) + f' @ {os.getcwd()}\n')
s = load()
if args[:1] == ['up']:
    # sortie progressive, comme l'évaluation Nix et la construction de devenv up
    import time
    for line in ['• Evaluating devenv.nix', '• Building shell', '• Starting processes']:
        print(line, flush=True)
        time.sleep(float(os.environ.get('FAKE_DEVENV_DELAY', '0.8')))
    s['running'] = True
    s['processes'] = {k: 'ready' for k in s['processes']}
    save(s)
    sys.exit(0)
if args[:1] != ['processes'] or len(args) < 2:
    print(f'commande non simulée : {args}', file=sys.stderr)
    sys.exit(2)
cmd, rest = args[1], args[2:]
if cmd == 'start' and rest and not s['running']:
    # un service nommé démarre aussi le process manager (seul ce service tourne)
    print('• Starting process manager', flush=True)
    s['running'] = True
    s['processes'] = {k: ('ready' if k == rest[0] else 'not_started') for k in s['processes']}
    save(s)
    sys.exit(0)
if not s['running']:
    print('  \x1b[31m×\x1b[0m No process manager is running. Start processes first with `devenv up -d`', file=sys.stderr)
    sys.exit(1)
name = rest[0] if rest else None
if cmd == 'list':
    for k, v in s['processes'].items():
        print(f'{k:<30} {v} restarts: {5 if v == "gave_up" else 0}')
elif cmd == 'down':
    s['running'] = False
elif cmd in ('start', 'restart'):
    s['processes'][name] = 'ready'
elif cmd == 'stop':
    s['processes'][name] = 'stopped'
elif cmd == 'logs':
    print(f'==> stdout <==\n{name} : ligne 1\n{name} : ligne 2')
save(s)
