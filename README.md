# opencode-gnome

Client GNOME pour [opencode](https://opencode.ai) : une application GTK 4 / libadwaita qui affiche
et pilote les mêmes sessions que la console, en direct.

On continue d'utiliser opencode dans le terminal ; l'application montre les mêmes projets et les
mêmes sessions, permet d'y répondre, et rouvre n'importe quelle session dans un terminal.

## Fonctionnalités

- **Projets et sessions** : barre latérale en arborescence (projets, sessions ouvertes dessous),
  favoris, recherche (`Ctrl+K`), état de chaque session (en cours, question, permission).
- **Conversation en direct** : réponses en streaming, markdown (tableaux, code, liens), réflexion
  et appels d'outils repliables (masquables d'un coup, `Ctrl+Maj+O`), images et fichiers joints,
  heure des messages et durée des réponses, liste de tâches de la session.
- **Interaction** : prompt avec choix de l'agent, du modèle et du niveau de raisonnement (`Ctrl+T`),
  commandes `/` et mentions `@` avec complétion, historique des prompts, pièces jointes
  (bouton, collage, glisser-déposer), questions et permissions directement dans la conversation.
- **Sessions** : renommer, forker, supprimer, ouvrir dans le terminal (`opencode attach`),
  fichiers modifiés (diff git) dans une fenêtre séparée, ouverture du dossier.
- **Terminaux persistants par projet** (zellij) : `devenv up`, `pnpm dev`… lancés en arrière-plan,
  rouverts à volonté, redémarrés ou arrêtés depuis leur pastille.
- **Notifications** de bureau avec son (session terminée, question, permission, erreur) ; clic =
  retour sur la session.
- **Préférences** (`Ctrl+,`) : terminal, modèle par défaut, taille du texte, largeur de la
  conversation, notifications.
- **Aide** (menu principal) : guide d'utilisation (`F1`, [`docs/guide.md`](docs/guide.md), aussi
  `ocg help guide`), raccourcis clavier (`Ctrl+?`), à propos (versions de l'app et d'opencode).

## Installation

Prérequis : NixOS ou Nix avec [devenv](https://devenv.sh), opencode installé, et zellij pour les
terminaux persistants.

```sh
git clone https://github.com/maarekj/opencode-gnome.git
cd opencode-gnome
devenv shell            # ou direnv allow
pnpm install
node scripts/install.ts
```

`scripts/install.ts` installe, pour l'utilisateur courant :

| Élément | Emplacement | Rôle |
|---|---|---|
| Service `opencode-gnome-server` | `~/.config/systemd/user/` | serveur opencode partagé, port 4096 |
| `oc` | `~/.local/bin/` | opencode en console, attaché au serveur partagé, dans le dossier courant |
| `opencode-gnome` | `~/.local/bin/` + `.desktop` + icône + service D-Bus | l'application (« opencode » dans GNOME) |

Ensuite, utiliser **`oc`** à la place de `opencode` dans le terminal : les sessions lancées ainsi
apparaissent en direct dans l'application, et inversement.

Le lanceur pointe vers le `gjs` et les bibliothèques du shell devenv : après un nettoyage du store
Nix, relancer `node scripts/install.ts`.

## Architecture

```
          systemd --user : opencode serve --port 4096  (serveur partagé)
             ▲                    ▲                          ▲
     oc (opencode attach)   opencode-gnome (GTK)     terminaux « Ouvrir dans le terminal »
       dans le terminal     HTTP + flux SSE global
```

### Pourquoi un serveur partagé

opencode est un client / serveur : la console (TUI) parle à un serveur HTTP. Les sessions sont
stockées sur disque, mais le **temps réel** (streaming, permissions, questions) ne passe que par
le serveur qui exécute la session. Un seul `opencode serve` permanent, utilisé par la console
(`oc`) et par l'application, permet de voir et piloter les mêmes sessions des deux côtés.

Un serveur gère tous les projets : chaque requête porte `?directory=…`, et le flux
`GET /global/event` émet les événements de tous les répertoires.

### Code

TypeScript strict, exécuté par **GJS** (GNOME JavaScript), interface en TSX avec
[gnim](https://github.com/aylur/gnim), bundlé par esbuild. Pas de Node à l'exécution.

```
src/
  shared/              logique sans interface (réutilisable par une future extension GNOME Shell)
    client.ts          client HTTP (libsoup 3) + flux SSE avec reconnexion
    schemas.ts         schémas zod/mini de l'API opencode (données externes toujours validées)
    store.ts           état réactif : projets, sessions, activité (en cours / question / permission)
    conversation.ts    messages d'une session, mis à jour en direct (deltas de streaming regroupés)
    settings.ts        réglages locaux (~/.config/opencode-gnome/settings.json)
    terminals.ts       terminaux persistants (sessions zellij)
    terminal.ts        ouverture d'un terminal externe (opencode attach…)
    markdown.ts        parseur markdown minimal -> blocs + markup Pango
  app/                 application Adw.Application
    main.tsx           application, actions (open-session, préférences…), raccourcis
    MainWindow.tsx     fenêtre : barre latérale (arbre, recherche, favoris), liste des sessions
    ConversationPage.tsx / ConversationView.tsx   page d'une session, flux de la conversation
    Composer.tsx       saisie du prompt (agent, modèle, variante, pièces jointes, complétion)
    Markdown.tsx       rendu markdown dans des Gtk.TextView (sélection libre, liens cliquables)
    Requests.tsx       cartes de questions / permissions dans le flux
    Notifier.ts        notifications (Gio.Notification) et sons (GSound)
    DiffWindow.tsx     fichiers modifiés (diff git)
    TerminalBar.tsx    pastilles des terminaux persistants
    …
scripts/               outillage Node 24 : build, installation, captures d'écran, types gnim
```

Points de conception :

- **Réactivité** : l'état est fait d'`Accessor` gnim. Un composant s'exécute une fois ; seules les
  valeurs liées se mettent à jour. Les listes ordonnées passent par `keyedBox` / `keyedListBox`
  (`src/app/KeyedBox.ts`) : une ligne n'est reconstruite que si sa clé change.
- **Streaming** : les deltas sont regroupés (~80 ms) ; seul le bloc concerné est redessiné.
- **Fluidité** : aucune construction lourde pendant une animation ; les pages des sessions
  ouvertes sont conservées en mémoire (prompt non envoyé, défilement).
- **Réglages** : fichier JSON validé par zod, rechargé s'il change (pour les autres processus).
- **Notifications** : l'application est activable par D-Bus (`DBusActivatable`) pour recevoir
  les clics ; elles ne fonctionnent que quand l'application est ouverte.

## Développement

Dans le shell devenv :

| Commande | Rôle |
|---|---|
| `pnpm check` | typecheck + lint (oxlint type-aware), obligatoire avant un commit |
| `pnpm build` / `pnpm start` | construire / lancer l'application |
| `pnpm screenshot [sortie.png] [-- --session ID]` | lancer l'app sur un écran virtuel (Xvfb) et en faire une capture |
| `node scripts/install.ts` | installer (ou mettre à jour) l'application |

Les changements d'interface se vérifient par captures sur écran virtuel, avec des interactions
simulées (`SCREENSHOT_XDOTOOL`) et un serveur de test (`opencode serve --port 4799`) ; voir
`AGENTS.md` pour les variables de test et les conventions.

Le projet est développé avec plusieurs agents opencode en parallèle, chacun dans son worktree
(`../opencode-gnome-2`…) avec sa propre application installée (« opencode (2) »…). Une issue
GitHub par fonctionnalité, une branche par issue ; règles détaillées dans `AGENTS.md`.

## Limites connues

- Les sessions lancées avec `opencode` seul (pas `oc`) tournent sur leur propre serveur :
  historique visible, activité en direct non.
- Les commandes de l'agent s'exécutent dans l'environnement du service systemd, sans le shell
  devenv / direnv du projet.
- GNOME interdit à une application de ramener au premier plan la fenêtre d'une autre :
  un terminal déjà ouvert n'est pas refocalisé.
- Pas d'extension GNOME Shell pour l'instant (indicateur, prompt rapide : voir `TODO.md`).
