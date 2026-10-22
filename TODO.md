# TODO

Les fonctionnalités planifiées sont suivies dans les issues GitHub :
https://github.com/maarekj/opencode-gnome/issues

- #1 Questions et permissions dans le flux de la conversation
- #2 États distincts « en cours » / « en attente » (barre latérale, store)
- #3 Images et fichiers : affichage et envoi dans le prompt
- #4 Actions sur les sessions : supprimer, renommer, forker, menu contextuel
- #5 Sélection de texte sur plusieurs paragraphes + bouton Copier
- #6 Fichiers modifiés : utiliser l'état git du répertoire (liste + diff)
- #7 Extension GNOME Shell : indicateur et notifications
- #8 Projets favoris : mode « Favoris » / « Tous » dans la barre latérale
- #9 Terminaux persistants par projet (zellij)

## Idées à trier
(idées pas encore transformées en issue)

- Option dans les préférences : Entrée ou Ctrl+Entrée pour envoyer (`SEND_WITH_CTRL`).
- Largeur des colonnes des tableaux markdown proportionnelle au contenu (aujourd'hui homogène).
- Charger l'historique ancien au-delà des 200 derniers messages (défilement vers le haut).
- Commandes des agents exécutées sans l'environnement devenv/direnv du projet (serveur systemd) :
  étudier `direnv exec`.
- Modèle présélectionné quand la session n'en a pas (nouvelle session, fork) : utiliser le `model`
  de la config opencode (`GET /config`) plutôt que le premier défaut des fournisseurs (openai).
- Menu d'actions de la session aussi dans l'en-tête de la conversation (renommer, forker, supprimer).
