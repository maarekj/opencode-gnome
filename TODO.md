# TODO

## Décidé — à faire

### Demandes en attente (questions, permissions)
- Afficher la carte **dans le flux de la conversation**, à la place de l'appel d'outil concerné
  (`tool.callID` de la demande), au lieu de l'empiler au-dessus de la saisie.
- Même traitement pour les permissions (Autoriser / Toujours / Refuser).
- Pastille au-dessus de la saisie (« 1 question en attente ») quand la carte n'est pas visible
  (utilisateur remonté dans l'historique) ; clic = défilement jusqu'à la carte.
- Après réponse : la carte devient une ligne repliée (question + réponse choisie), dépliable.
- Sous-titre de l'en-tête : distinguer « Question en attente » de « Permission demandée »
  (le store mélange les deux dans le même ensemble).
- Ne plus afficher la ligne d'outil « question question » (remplacée par la carte).
- Saisie libre : lien « Autre réponse » qui révèle le champ, au lieu d'un champ par question.
- La carte doit respecter la largeur de la conversation (Clamp ~860 px).

### Barre latérale
- Le badge actuel compte les sessions « actives » sans distinguer les cas. Séparer :
  spinner = l'agent travaille ; icône orange + nombre = en attente d'une réponse de l'utilisateur.
- Projets sans session (ex. dossier supprimé, projet git conservé par opencode) : les masquer
  ou les regrouper en bas.

### Images et fichiers
- Affichage : les parties `file` image (`mime: image/*`, `url` en `data:` base64, ~1 Mo) →
  miniature dans la bulle du message ; clic = aperçu plein écran (Adw.Dialog + Gtk.Picture).
  Remplacer le repère « [Image N] » inséré par le TUI par la miniature correspondante,
  et supprimer la ligne « clipboard ». Décoder à l'affichage seulement (pas au chargement).
- Fichiers non-image : puce avec icône du type MIME + nom, clic = ouvrir avec l'app par défaut.
- Envoi dans le prompt : bouton « joindre » (Gtk.FileDialog), collage depuis le presse-papier
  (Ctrl+V : Gdk.Clipboard texture ou fichiers) et glisser-déposer. Miniatures des pièces jointes
  au-dessus de la saisie, avec bouton pour les retirer. Envoi en `FilePartInput`
  (`type: file`, `mime`, `filename`, `url` data: ou file://).

### Actions sur les sessions
- Icône corbeille à côté de l'icône terminal (avec confirmation Adw.AlertDialog).
- Clic droit (et appui long) sur une session : menu contextuel
  Ouvrir · Ouvrir dans le terminal · Renommer · Forker · Supprimer.
  API : `PATCH /session/:id` { title }, `POST /session/:id/fork`, `DELETE /session/:id`.

### Sélection de texte dans la conversation
- Aujourd'hui chaque paragraphe est un Gtk.Label séparé : GTK ne peut pas étendre une
  sélection d'un label à l'autre. Pistes :
  1. Rendre chaque message dans un seul Gtk.TextView non éditable (markdown -> TextTags) :
     sélection libre sur tout le message. Tableaux et blocs de code via ancres de widgets.
  2. Bouton « Copier » au survol de chaque message (copie le markdown source).
  3. Les deux (recommandé).
  Sélection à travers plusieurs messages : hors de portée sans tout rendre dans un seul TextView.

### Fichiers modifiés
- Le dialogue actuel utilise `/session/:id/diff` (instantanés internes d'opencode, limités aux
  modifications faites par la session) : vide en pratique (ex. dépôt sans commit -> projet `global`).
- Remplacer par l'état git du répertoire : `GET /vcs/diff?mode=git` (liste + patch par fichier :
  `file`, `status`, `additions`, `deletions`, `patch`), indépendant de la session.
- Mise en page : Adw.NavigationSplitView dans le dialogue, liste des fichiers à gauche
  (icône du statut, +/−), diff du fichier sélectionné à droite. Rafraîchissement sur
  `session.diff` / `file.edited` et bouton manuel.
- Plus tard : option `mode=branch` (diff de la branche par rapport à sa base).

## Idées à trier
