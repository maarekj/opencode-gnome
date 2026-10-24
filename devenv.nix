{ pkgs, ... }:
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
  ];

  # opencode n'est pas fourni ici : on utilise celui de l'utilisateur (même version que la console).

  enterShell = ''
    echo "opencode-gnome — opencode $(opencode --version 2>/dev/null || echo 'introuvable')"
  '';
}
