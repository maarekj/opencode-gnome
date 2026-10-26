"""Voix : dictée et lecture à voix haute, moteurs simulés (bac à sable : DICTEE / LECTURE journalisés)."""

from conftest import scenario, wait_until


def test_dictee_inseree_puis_envoyee(run_app):
    fake, app = run_app(scenario('demo'), '--session', 'ses_a')
    app.text_visible('La connexion échoue')
    app.click('button', contains='Dicter')
    app.logged('DICTEE', 'début')
    # aperçu affiché pendant la dictée
    app.logged('DICTEE', 'aperçu')
    wait_until(lambda: app.composer().text == 'Texte dicté', 5, 'aperçu dans le compositeur')
    # enregistrement en cours : le bouton termine la dictée
    app.click('button', contains='Terminer la dictée')
    app.logged('DICTEE', 'fin')
    composer = app.composer()
    wait_until(lambda: composer.text == 'Texte dicté au micro', 5, 'texte dicté dans le compositeur')
    # relu, pas envoyé automatiquement
    assert not fake.requests('POST', '/session/ses_a/prompt_async')
    app.click('button', contains='Envoyer')
    req = fake.wait_request('POST', '/session/ses_a/prompt_async')
    assert req['body']['parts'][0]['text'] == 'Texte dicté au micro'


def test_dictee_annulee_par_echap(run_app):
    _, app = run_app(scenario('demo'), '--session', 'ses_a')
    app.text_visible('La connexion échoue')
    app.click('button', contains='Dicter')
    app.logged('DICTEE', 'début')
    wait_until(lambda: app.composer().text == 'Texte dicté', 5, 'aperçu dans le compositeur')
    app.key('Escape')
    app.logged('DICTEE', 'annulée')
    app.find('button', contains='Dicter')
    # aperçu retiré
    wait_until(lambda: app.composer().text == '', 5, 'compositeur vidé')


def test_dictee_envoi_automatique(run_app):
    fake, app = run_app(scenario('demo'), '--session', 'ses_a', settings={'voice': {'autoSend': True}})
    app.text_visible('La connexion échoue')
    app.click('button', contains='Dicter')
    app.logged('DICTEE', 'début')
    app.click('button', contains='Terminer la dictée')
    req = fake.wait_request('POST', '/session/ses_a/prompt_async')
    assert req['body']['parts'][0]['text'] == 'Texte dicté au micro'


def test_lire_une_reponse_puis_arreter(run_app):
    _, app = run_app(scenario('demo'), '--session', 'ses_a')
    app.text_visible('chien de garde')
    app.click('button', 'Lire à voix haute')
    # markdown nettoyé : ni astérisques ni balises
    assert app.logged('LECTURE', 'Le chien de garde du flux SSE ne se réarme pas')
    app.find('button', 'Arrêter la lecture (Échap)')
    app.key('Escape')
    app.logged('LECTURE', 'arrêt')
    wait_until(lambda: not app.has('button', 'Arrêter la lecture (Échap)'), 5, 'lecture arrêtée')


def test_preferences_de_la_voix(run_app):
    _, app = run_app(scenario('composer'))
    app.key('<Control>comma')
    dialog = app.find('dialog', 'Préférences')
    app.click('page tab', 'Voix')
    app.combo('Moteur', 'OpenAI (en ligne)', within=dialog)
    wait_until(lambda: app.settings().get('voice', {}).get('stt') == 'openai', 5, 'moteur de dictée enregistré')
    app.toggle('switch', 'Envoyer automatiquement')
    wait_until(lambda: app.settings().get('voice', {}).get('autoSend') is True, 5, 'envoi automatique enregistré')
    key = app.find('password text', 'Clé API OpenAI', within=dialog)
    key.text = 'sk-test'
    wait_until(lambda: app.settings().get('voice', {}).get('openaiKey') == 'sk-test', 5, 'clé enregistrée')


def test_dictee_au_clavier(run_app):
    _, app = run_app(scenario('demo'), '--session', 'ses_a')
    app.text_visible('La connexion échoue')
    # Ctrl+M dans le compositeur (appui bref) : commence, puis termine
    app._point(app.composer(), 'b1c')
    app.key('<Control>m')
    app.logged('DICTEE', 'début')
    app.key('<Control>m')
    app.logged('DICTEE', 'fin')
    wait_until(lambda: app.composer().text == 'Texte dicté au micro', 5, 'texte dicté dans le compositeur')


def test_modele_telecharge_au_choix(run_app):
    _, app = run_app(scenario('composer'))
    app.key('<Control>comma')
    dialog = app.find('dialog', 'Préférences')
    app.click('page tab', 'Voix')
    app.combo('Modèle whisper', 'medium · 1,5 Go', within=dialog)
    # téléchargement lancé dès le choix (simulé), avancement affiché
    app.logged('TELECHARGEMENT', 'ggml-medium.bin')
    assert app.text_visible('Téléchargement…')
    wait_until(lambda: app.settings().get('voice', {}).get('whisperModel') == 'medium', 5, 'modèle enregistré')


def test_ouvrir_le_dossier_des_modeles(run_app):
    _, app = run_app(scenario('composer'))
    app.key('<Control>comma')
    app.find('dialog', 'Préférences')
    app.click('page tab', 'Voix')
    # bas de la page (hors écran) : action d'accessibilité plutôt qu'un clic
    app.find('button', 'Ouvrir le dossier des modèles', showing=False).doActionNamed('click')
    assert app.logged('DOSSIER', 'opencode-gnome/voice')
