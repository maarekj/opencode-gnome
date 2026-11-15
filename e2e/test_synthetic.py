"""Entrées synthetic d'OpenCode 2 (#179) : sous-agent d'une commande et commande en arrière-plan affichés."""

from conftest import scenario

SUB = {
    'type': 'synthetic', 'id': 'msg_900', 'time': {'created': 1792900100000},
    'description': 'Relecture des changements',
    'metadata': {'source': 'subagent', 'childID': 'ses_b', 'agent': 'build', 'state': 'completed'},
    'text': '<subagent sessionID="ses_b" state="completed" description="Relecture des changements">\nAucun problème trouvé.\n</subagent>',
}
SHELL = {
    'type': 'synthetic', 'id': 'msg_901', 'time': {'created': 1792900110000},
    'metadata': {'source': 'shell', 'shellID': 'sh_1', 'state': 'completed', 'exit': 0},
    'text': '<shell id="sh_1" state="completed" command="pnpm test">\n12 tests réussis\n</shell>',
}
NUDGE = {'type': 'synthetic', 'id': 'msg_902', 'time': {'created': 1792900120000}, 'text': 'Summarize the task tool output above and continue with your task.'}


def data():
    d = scenario('demo')
    d['messages']['ses_a'] = d['messages']['ses_a'] + [SUB, SHELL, NUDGE]
    return d


def test_sous_agent_d_une_commande_affiche_et_ouvrable(run_app):
    _, app = run_app(data(), '--session', 'ses_a')
    app.text_visible('Relecture des changements')
    app.click(None, 'Rapport')
    assert app.text_visible('Aucun problème trouvé.')
    # bouton de la carte : nommé par son contenu (infobulle en description)
    card = app.find('button', contains='@build Relecture des changements')
    assert card.description == 'Ouvrir la conversation du sous-agent'
    card.doActionNamed('click')
    # conversation du sous-agent (session ses_b)
    assert app.text_visible('Lance les tests.')


def test_commande_en_arriere_plan_et_relances_masquees(run_app):
    _, app = run_app(data(), '--session', 'ses_a')
    app.text_visible('12 tests réussis')
    assert not app.has(None, contains='Summarize the task tool output')


def test_sous_agent_en_arriere_plan_sans_faux_rapport(run_app):
    d = data()
    d['messages']['ses_a'].insert(2, {
        'type': 'assistant', 'id': 'msg_850', 'time': {'created': 1792900095000, 'completed': 1792900096000}, 'agent': 'build',
        'model': {'id': 'fake-model', 'providerID': 'fake'},
        'content': [{'type': 'tool', 'id': 'call_bg', 'name': 'subagent', 'time': {'created': 1792900095000, 'completed': 1792900096000}, 'state': {'status': 'completed', 'input': {'agent': 'general', 'description': 'Recherche en arrière-plan'},
                     'metadata': {'sessionId': 'ses_b'}, 'content': [{'type': 'text', 'text': 'The subagent is working in the background (sessionID: ses_b). You will be notified automatically when it finishes.'}]}}],
    })
    _, app = run_app(d, '--session', 'ses_a')
    card = app.find('button', contains='@general Recherche en arrière-plan')
    assert 'Lancé en arrière-plan' in card.name
    assert not app.has(None, contains='working in the background')
