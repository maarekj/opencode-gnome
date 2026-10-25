# opencode-gnome

Client GNOME pour opencode : une application GTK 4 / libadwaita et (à venir) une extension
GNOME Shell, connectées à un serveur `opencode serve` partagé avec la console (`oc`).

## Architecture
- `src/shared/` : code GJS commun (app + extension). Client HTTP/SSE libsoup 3 (`client.ts`),
  schémas zod/mini (`schemas.ts`), état réactif des projets/sessions (`store.ts`),
  conversation en direct (`conversation.ts`), ouverture de terminal (`terminal.ts`).
- `src/app/` : application `Adw.Application` en TSX avec gnim (`gnim/gtk4`).
- `src/cli/` : CLI `ogt` des tâches planifiées (GJS). Tâches dans `src/shared/tasks.ts` (config
  `tasks.json`, timers systemd utilisateur générés, journal `runs.jsonl`). Tests : lanceur avec
  `OGT_NAMESPACE=test`, `OGT_UNIT_DIR=$XDG_RUNTIME_DIR/systemd/user`, `XDG_CONFIG_HOME`/`XDG_DATA_HOME`
  dans /tmp, `OPENCODE_GNOME_URL` du serveur de test, `OPENCODE_GNOME_TEST_NOTIFY=1`.
- `scripts/` : outillage Node 24 (build esbuild, types gnim, installation locale, captures).
- Serveur partagé : unité systemd utilisateur `opencode-gnome-server` (port 4096),
  installée par `node scripts/install.ts`.

## Commandes (dans le shell devenv)
- `pnpm check` : typecheck + lint (oxlint type-aware) + `pnpm test`. Doit passer avant chaque commit.
- `pnpm test` : specs unitaires jasmine-gjs (`specs/*.spec.ts`, describe / it / expect ; une seule :
  `pnpm test specs/git.spec.ts`), puis tests GJS sous Xvfb (`tests/*.ts`, bundlés) ; échec sur tout `Gtk-WARNING`/`Gtk-CRITICAL`
  ou délai dépassé. Ne jamais attacher un `Gtk.Popover` (`set_parent`) à un `Gtk.TextView` (#54).
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
- **`opencode-gnome` (dépôt principal) est l'orchestre** : toujours sur `main`, propre (aucune
  modification non commitée), **jamais de développement**. On y crée et répartit les issues, on y
  suit l'avancement, et on y installe la version de référence (serveur partagé, `oc`, `ogt`,
  plugin opencode, application « opencode »).
- **Tout le développement se fait dans les worktrees**, un agent par dossier :

  | Dossier | Rôle / branche | Port du serveur de test | Application installée |
  |---|---|---|---|
  | `opencode-gnome` | orchestre, `main` | 4799 | « opencode » (`opencode-gnome`) |
  | `opencode-gnome-2` | agent 2, `agent-2` | 4798 | « opencode (2) » (`opencode-gnome-2`) |
  | `opencode-gnome-3` | agent 3, `agent-3` | 4797 | « opencode (3) » (`opencode-gnome-3`) |
  | `opencode-gnome-4` | agent 4, `agent-4` | 4796 | « opencode (4) » (`opencode-gnome-4`) |

- Ne jamais toucher au dossier d'un autre agent, ni arrêter son serveur de test.
- Une issue = un seul agent : avant de commencer, vérifier qu'elle n'est pas déjà prise, puis
  commenter « En cours dans <dossier> » sur l'issue.
- En prenant une issue, **renommer sa session opencode** : `[Agent N] - #<numéro> <titre de l'issue>`
  (N = numéro du worktree ; la session de l'orchestre : `[Orchestre] …`). Sa propre session est la
  plus récemment mise à jour dans son dossier :
  `curl -s "http://127.0.0.1:4096/experimental/session?roots=true&limit=50" | jq -r --arg d "$PWD" '[.[]|select(.directory==$d)]|max_by(.time.updated).id'`, puis
  `curl -s -X PATCH "http://127.0.0.1:4096/session/<id>?directory=$PWD" -H 'content-type: application/json' -d '{"title":"…"}'`.
- **Aucun commit, rebase, fusion ni push sans l'ordre explicite de l'utilisateur.** Une fois
  l'implémentation prête (`pnpm check` OK, captures faites), installer l'application
  (`node scripts/install.ts`), présenter ce qu'il faut tester et attendre sa validation.
- **Une branche par issue** : `git switch -c issue-<numéro>` depuis sa branche `agent-N` à jour
  (`git fetch && git merge --ff-only origin/main`). Jamais de commit direct sur `main`.
- **Fusion**, une fois l'issue validée et sur ordre de l'utilisateur, depuis le worktree :
  1. `git fetch && git rebase origin/main`, puis `pnpm check` ;
  2. `git push origin issue-<numéro>:main` (refusé si `main` a avancé : refaire l'étape 1) ;
  3. mise à jour de l'orchestre : `git -C ../opencode-gnome pull --ff-only` (seule commande
     autorisée dans ce dossier depuis un worktree ; s'il n'est pas propre ou pas sur `main`, ne
     rien faire et le signaler) ;
  4. `git switch agent-N && git merge --ff-only origin/main && git branch -D issue-<numéro>`.
- Chaque agent construit **et installe** son application après une modification d'interface :
  `node scripts/install.ts` (dans le shell devenv). Chaque dossier a son lanceur, son .desktop et
  son identifiant d'application : toutes les versions apparaissent dans GNOME et tournent ensemble.
  Le serveur partagé, `oc`, `ogt` et le plugin opencode ne sont installés que depuis l'orchestre
  (après une fusion qui les modifie : `node scripts/install.ts` dans `opencode-gnome`, à
  demander à l'utilisateur).

## Suivi des fonctionnalités : issues GitHub
Dépôt : https://github.com/maarekj/opencode-gnome
- **Chaque fonctionnalité ou correctif a son issue**, créée avant de commencer
  (`gh issue create`), avec le besoin, la solution envisagée et les critères de validation.
- Les commits y font référence (`#12`) ; `Closes #12` dans le commit qui la termine.
- **Quand l'implémentation est finie, commenter l'issue** (`gh issue comment`) avec un
  récapitulatif : ce qui a été fait, comment c'est vérifié (captures, tests), limites connues
  et ce qui n'a pas été testé.
- Les idées non encore planifiées restent dans `TODO.md` jusqu'à leur passage en issue.
