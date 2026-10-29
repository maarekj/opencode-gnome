# Guide d'utilisation

opencode-gnome affiche et pilote, en direct, les mêmes projets et sessions qu'opencode en console. L'application et la console parlent au même **serveur partagé** (service `opencode-gnome-server`, port 4096) : une session lancée d'un côté se suit et se poursuit de l'autre.

## Démarrer

- Dans un terminal, utiliser **`oc`** à la place de `opencode` : la console s'attache au serveur
  partagé, dans le dossier courant. Une session lancée avec `opencode` seul tourne sur son propre
  serveur : son historique est visible, mais pas son activité en direct.
- L'application s'ouvre depuis GNOME (« opencode »). Si le serveur est injoignable, un bandeau le
  signale et la connexion est retentée automatiquement.
- Menu principal → **Serveur opencode** : état du service, démarrer / arrêter / redémarrer,
  journal, accès depuis le réseau (mot de passe, adresses avec QR code).

## Projets et sessions

- La **barre latérale** liste les projets, avec leurs sessions ouvertes dessous. Le mode
  **Favoris** garde un ordre fixe, réordonnable par glisser-déposer.
- **Ctrl+K** recherche un projet ; **Ctrl+F**, sur la page d'un projet, recherche une session.
- L'état de chaque session est indiqué : en cours, question en attente, permission demandée,
  réponse non lue (point et texte en gras jusqu'à l'ouverture).
- Clic droit sur une session : renommer, forker, supprimer, ouvrir dans le terminal
  (`opencode attach`), ouvrir le dossier.
- **Ctrl+W** ferme la session affichée (elle reste disponible dans le projet).

## Conversation

- Les réponses arrivent en direct, rendues en markdown (titres, listes, tableaux, code, liens
  cliquables). La sélection de texte s'étend librement sur tout un message.
- La réflexion et les appels d'outils sont repliables ; **Ctrl+Maj+O** les masque ou les
  affiche tous d'un coup.
- Les messages plus anciens se chargent en remontant dans la conversation.
- Au survol d'un message, un bouton permet de **forker** la session à partir de ce message.
- Les **questions** et **permissions** de l'agent s'affichent sous forme de cartes dans la
  conversation : y répondre directement.

## Écrire un prompt

- **Ctrl+Entrée** envoie le prompt.
- Choisir l'agent, le modèle et le niveau de raisonnement sous la zone de saisie ; **Ctrl+T**
  passe au niveau de raisonnement suivant.
- `/` propose les commandes, `@` les fichiers et agents à mentionner (Tab ou Entrée pour
  compléter, Échap pour fermer).
- **Haut** / **Bas** parcourent l'historique des prompts envoyés.
- Pièces jointes : bouton trombone, collage (Ctrl+V d'une image ou de fichiers) ou
  glisser-déposer.

## Fichiers modifiés et git

Le bouton git de l'en-tête ouvre une fenêtre séparée : fichiers modifiés (diff), journal, branches, comparaison, et onglet **Issues** (GitHub, via `gh`). **F5** recharge, **Échap** ferme.

## Terminaux

- **Barre du projet**, sous l'en-tête : terminaux persistants et liens épinglés, mélangés dans
  l'ordre choisi par glisser-déposer, et **dossiers** (ex. un par worktree, « utilitaires »). Le
  bouton **+** ajoute un terminal, un lien ou un dossier.
- **Terminaux persistants** par projet (zellij) : `devenv up`, `pnpm dev`… tournent en
  arrière-plan ; leurs pastilles permettent de les rouvrir, redémarrer ou arrêter.
- **Dossiers** : un clic ouvre la liste de leurs terminaux et liens ; un dossier contenant un
  terminal en cours est coloré et affiche leur nombre. Glisser une pastille au milieu d'un dossier
  l'y range ; clic droit → « Déplacer dans… » / « Sortir du dossier » ; clic droit sur un dossier :
  renommer, supprimer (son contenu reste dans la barre).
- **Terminal intégré** : **Ctrl+Maj+J** ouvre ou ferme le panneau à onglets du projet (shell,
  terminaux persistants, `opencode attach`). Copier / coller : **Ctrl+Maj+C** / **Ctrl+Maj+V** ;
  zoom : **Ctrl+plus**, **Ctrl+moins**, **Ctrl+0**.
- **Liens épinglés** par projet : adresses web, avec les variables `$VAR` du direnv du projet ;
  le navigateur du projet se choisit à droite de la barre.
- **devenv** : un élément de la barre (bouton **+** → « Nouveau devenv ») suit le process manager de
  `devenv up` d'un dossier. Sa pastille résume l'état des services (prêts, en échec, arrêté) ; un
  clic ouvre la liste des services : démarrer, arrêter, redémarrer, logs (fenêtre dédiée), et
  « Tout démarrer » (`devenv up --detach`) / « Tout arrêter ».
- En ligne de commande : `ocg terminal`, `ocg link`, `ocg devenv` (option `--folder`) et `ocg folder`.
- Le projet s'ouvre aussi dans un **IDE** (en-tête ou menu du projet).

## Tâches planifiées

Menu principal → **Tâches planifiées** : un prompt lancé à heure fixe (ou à la main) dans un projet, par un timer systemd utilisateur. L'historique des runs signale les échecs (pastille sur le menu principal). Les mêmes tâches se gèrent en ligne de commande avec `ocg task` (`ocg help task`). `ocg terminal` et `ocg link` gèrent de même les terminaux persistants et les liens épinglés (`ocg help all`).

## MCP, skills et plugins

Menu principal → **MCP, skills et plugins (global)** : serveurs MCP configurés, leurs outils (« Voir les outils »), skills et plugins d'opencode.

## Notifications

Une notification de bureau, avec son, signale une session terminée, une question, une permission ou une erreur ; un clic ramène sur la session. Une permission peut être accordée directement depuis la notification. Les notifications ne fonctionnent que quand l'application est ouverte.

## Préférences

**Ctrl+,** : terminal externe, modèle par défaut, thème de l'application et du terminal intégré, rendu des messages (police, taille, largeur, interligne, couleurs), notifications.

## Aide

- **F1** : ce guide.
- **Ctrl+?** : la liste des raccourcis clavier.
- Menu principal → **À propos** : versions de l'application et d'opencode, dépôt du projet.
- En ligne de commande : `ocg help guide` affiche ce guide.

## Limites connues

- Les commandes de l'agent s'exécutent dans l'environnement du service systemd ; les variables
  direnv du projet sont toutefois chargées par le plugin opencode installé.
- GNOME interdit à une application de ramener au premier plan la fenêtre d'une autre : un
  terminal déjà ouvert n'est pas refocalisé.
