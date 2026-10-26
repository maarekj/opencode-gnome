"""Recherche dans toutes les conversations (Ctrl+Maj+F) : index construit depuis le faux opencode."""

from conftest import scenario, wait_until


def test_recherche_ouvre_le_message(run_app):
    fake, app = run_app(scenario('demo'))
    app.key('<Control><Shift>f')
    app.find('entry', 'Rechercher dans toutes les conversations')
    # mot d'une réponse de l'agent, sans accent ni casse
    app.type('REARME')
    # la session et l'extrait apparaissent
    app.find('list item', contains='Corriger le bug de connexion')
    assert app.text_visible('réarme')
    assert fake.requests('GET', '/session/ses_a/message')
    app.key('Return')
    # la session s'ouvre sur le message trouvé
    assert app.text_visible('chien de garde')
    wait_until(lambda: not app.has('entry', 'Rechercher dans toutes les conversations'), 5, 'dialogue fermé')


def test_recherche_sans_resultat(run_app):
    _, app = run_app(scenario('demo'))
    app.key('<Control><Shift>f')
    app.find('entry', 'Rechercher dans toutes les conversations')
    app.type('introuvablexyz')
    assert app.text_visible('Aucun résultat')
