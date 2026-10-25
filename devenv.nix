{ pkgs, ... }:
let
  # Jasmine pour GJS (tests unitaires, `pnpm test`) : ni dans nixpkgs ni sur npm (le paquet npm
  # « jasmine-gjs » est vide et publié par un tiers) ; construit depuis la version publiée par
  # son auteur (ptomato, mainteneur de GJS).
  jasmine-gjs = pkgs.stdenv.mkDerivation {
    pname = "jasmine-gjs";
    version = "3.10.1";
    src = pkgs.fetchFromGitHub {
      owner = "ptomato";
      repo = "jasmine-gjs";
      rev = "3.10.1";
      hash = "sha256-lVUd7kicl48T471QcRSUE1R/A0rQ0teAgrX+oHmfUEY=";
    };
    nativeBuildInputs = [ pkgs.meson pkgs.ninja ];
    buildInputs = [ pkgs.gjs ];
    # ses propres tests demandent un affichage : inutiles ici
    doCheck = false;
    # GJS ≥ 1.80 : Gio.UnixOutputStream a migré dans GioUnix (sinon avertissement à chaque lancement)
    postPatch = ''
      substituteInPlace src/consoleReporter.js \
        --replace-fail "import Gio from 'gi://Gio';" "import Gio from 'gi://Gio';
      import GioUnix from 'gi://GioUnix';" \
        --replace-fail "new Gio.UnixOutputStream(" "new GioUnix.OutputStream("
    '';
  };
in
{
  # Node 24 : outillage (TypeScript, esbuild, oxlint), scripts exécutés nativement.
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    pnpm = {
      enable = true;
      install.enable = true;
    };
  };

  packages = [
    pkgs.gjs # runtime de l'app et de l'extension
    pkgs.gtk4
    pkgs.libadwaita
    pkgs.libsoup_3 # client HTTP/SSE vers opencode serve
    pkgs.gsound # sons d'événement (thème de sons du bureau) pour les notifications
    pkgs.gtksourceview5 # vue de code (diffs : coloration syntaxique)
    pkgs.vte-gtk4 # terminal intégré (Vte-3.91)
    pkgs.glib # gdbus, glib-compile-schemas, glib-compile-resources
    pkgs.gobject-introspection
    pkgs.curl # spikes / debug de l'API opencode
    pkgs.jq
    # captures de l'interface sur un écran virtuel (scripts/screenshot.ts)
    pkgs.xvfb-run
    pkgs.imagemagick
    pkgs.xdotool # clics / saisie simulés pendant les captures (SCREENSHOT_XDOTOOL)
    pkgs.xclip # presse-papier de l'écran virtuel (tests du collage)
    jasmine-gjs # tests unitaires (specs/*.spec.ts)
  ];

  # opencode n'est pas fourni ici : on utilise celui de l'utilisateur (même version que la console).

  enterShell = ''
    echo "opencode-gnome — opencode $(opencode --version 2>/dev/null || echo 'introuvable')"
  '';
}
