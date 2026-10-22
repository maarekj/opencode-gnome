import GLib from 'gi://GLib';

/** Port du serveur opencode partagé (unité systemd `opencode-gnome-server`). */
export const DEFAULT_PORT = 4096;

/** URL du serveur opencode partagé : $OPENCODE_GNOME_URL ou http://127.0.0.1:4096. */
export function serverUrl(): string {
  return GLib.getenv('OPENCODE_GNOME_URL') ?? `http://127.0.0.1:${DEFAULT_PORT}`;
}
