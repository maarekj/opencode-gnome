# TODO

Les fonctionnalités planifiées sont suivies dans les issues GitHub :
https://github.com/maarekj/opencode-gnome/issues

Issues ouvertes (retirer une issue de la liste quand elle est fermée) :

- #7 Extension GNOME Shell : indicateur et notifications
- #9 Terminaux persistants par projet (zellij) : devenv up, pnpm dev…
- #18 Barre latérale en arborescence : projets en dossiers, sessions dessous avec activité et menu
- #19 Commandes « / » dans le compositeur : complétion des commandes, skills et commandes intégrées
- #20 Mentions « @ » dans le compositeur : complétion des fichiers du projet
- #21 Historique des prompts de la session avec Haut / Bas dans le compositeur
- #25 Liste de tâches (todolist) de la session dans la conversation

## Idées à trier
(idées pas encore transformées en issue)

- Option dans les préférences : Entrée ou Ctrl+Entrée pour envoyer (`SEND_WITH_CTRL`).
- Largeur des colonnes des tableaux markdown proportionnelle au contenu (aujourd'hui homogène).
- Charger l'historique ancien au-delà des 200 derniers messages (défilement vers le haut).
- Commandes des agents exécutées sans l'environnement devenv/direnv du projet (serveur systemd) :
  étudier `direnv exec`.
- Menu d'actions de la session aussi dans l'en-tête de la conversation (renommer, forker, supprimer).
