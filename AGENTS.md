# opencode-gnome

Client GNOME pour opencode : une application GTK 4 / libadwaita et (à venir) une extension
GNOME Shell, connectées à un serveur `opencode serve` partagé avec la console (`oc`).

## Architecture
- `src/shared/` : code GJS commun (app + extension). Client HTTP/SSE libsoup 3 (`client.ts`),
  schémas zod/mini (`schemas.ts`), état réactif des projets/sessions (`store.ts`),
  conversation en direct (`conversation.ts`), ouverture de terminal (`terminal.ts`).
- `src/app/` : application `Adw.Application` en TSX avec gnim (`gnim/gtk4`).
- `scripts/` : outillage Node 24 (build esbuild, types gnim, installation locale, captures).
- Serveur partagé : unité systemd utilisateur `opencode-gnome-server` (port 4096),
  installée par `node scripts/install.ts`.

## Commandes (dans le shell devenv)
- `pnpm check` : typecheck + lint (oxlint type-aware). Doit passer avant chaque commit.
- `pnpm build` / `pnpm start` : construire / lancer l'application.
- `pnpm screenshot [sortie.png] [-- --session ID]` : lance l'app sur un écran virtuel (Xvfb)
  et en fait une capture. Toujours valider un changement d'interface ainsi, jamais en ouvrant
  une fenêtre sur l'écran de l'utilisateur. Interactions simulées avec
  `SCREENSHOT_XDOTOOL="mousemove X Y click 1; type texte; key ctrl+Return; sleep 2"`
  (`sh: commande` pour une commande shell, ex. `xclip` pour remplir le presse-papier).
  `OPENCODE_GNOME_TEST_SCROLL=top` : la conversation reste en haut (test de la pastille).
  Pour des clics dans la barre latérale, pointer l'app sur un serveur de test
  (`opencode serve --port 4799` + `OPENCODE_GNOME_URL=http://127.0.0.1:4799`) : sur le serveur
  partagé, la session de l'agent en cours fait bouger l'ordre des projets pendant le test.
  `OPENCODE_GNOME_TIMING=1` : temps de construction de la conversation dans les logs.
  `OPENCODE_GNOME_TEST_LINKS=1` : un clic sur un lien est journalisé (`LIEN url`) au lieu d'ouvrir le navigateur.
  Ne pas toucher aux réglages de l'utilisateur en test : `XDG_CONFIG_HOME=/tmp/...`.

## Conventions
- TypeScript strict ; données externes validées avec zod/mini.
- Interface et messages en français ; commentaires de code en français.
- gnim n'est pas React : un composant s'exécute une fois, seules les valeurs liées se mettent à jour.
  Pour une liste ordonnée, utiliser `keyedBox` / `keyedListBox` (`src/app/KeyedBox.ts`), pas `<For>`.
  Pas de `<With>` directement dans un `<With>` (Fragments imbriqués non gérés) : intercaler un `Gtk.Box`.
- Ne jamais bloquer la boucle principale pendant une animation (voir `ConversationPage.tsx`).
- Messages de commit en français, courts, au style des commits existants.

## Travail en parallèle (worktrees)
- Plusieurs agents travaillent en même temps, chacun dans son dossier :

  | Dossier | Branche | Port du serveur de test | Application installée |
  |---|---|---|---|
  | `opencode-gnome` | `main` | 4799 | « opencode » (`opencode-gnome`) |
  | `opencode-gnome-2` | `agent-2` | 4798 | « opencode (2) » (`opencode-gnome-2`) |
  | `opencode-gnome-3` | `agent-3` | 4797 | « opencode (3) » (`opencode-gnome-3`) |
  | `opencode-gnome-4` | `agent-4` | 4796 | « opencode (4) » (`opencode-gnome-4`) |

- Ne jamais toucher au dossier d'un autre agent, ni arrêter son serveur de test.
- Une issue = un seul agent : avant de commencer, vérifier qu'elle n'est pas déjà prise, puis
  commenter « En cours dans <dossier> » sur l'issue.
- Dans un worktree : commits sur sa branche ; une fois l'issue terminée et `pnpm check` OK,
  `git rebase main` puis fusion dans `main` : `git -C ../opencode-gnome merge --ff-only agent-N`
  (si `main` a avancé entre-temps, refaire le rebase), puis `git -C ../opencode-gnome push`.
- Chaque agent construit **et installe** son application après une modification d'interface :
  `node scripts/install.ts` (dans le shell devenv). Chaque dossier a son lanceur, son .desktop et
  son identifiant d'application : toutes les versions apparaissent dans GNOME et tournent ensemble.
  Le serveur partagé et `oc` ne sont installés que depuis le dépôt principal.

## Suivi des fonctionnalités : issues GitHub
Dépôt : https://github.com/maarekj/opencode-gnome
- **Chaque fonctionnalité ou correctif a son issue**, créée avant de commencer
  (`gh issue create`), avec le besoin, la solution envisagée et les critères de validation.
- Les commits y font référence (`#12`) ; `Closes #12` dans le commit qui la termine.
- **Quand l'implémentation est finie, commenter l'issue** (`gh issue comment`) avec un
  récapitulatif : ce qui a été fait, comment c'est vérifié (captures, tests), limites connues
  et ce qui n'a pas été testé.
- Les idées non encore planifiées restent dans `TODO.md` jusqu'à leur passage en issue.
