// Rechargement de la configuration d'un projet (opencode.json, agents, commandes, skills, MCP) :
// le serveur partagé libère l'instance du projet, relue à la requête suivante. Les autres projets
// ne sont pas touchés ; une réponse en cours dans ce projet peut être interrompue (confirmation).
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import type Gtk from 'gi://Gtk?version=4.0';
import type { OpencodeClient } from '../shared/client.ts';
import { errorMessage } from '../shared/errors.ts';

async function reload(client: OpencodeClient, directory: string, toast: (m: string) => void): Promise<void> {
  try {
    await client.disposeInstance(directory);
    // relecture immédiate : l'instance (et ses MCP) est recréée sans attendre la prochaine action
    await client.mcpStatus(directory).catch(() => ({}));
    toast(`Configuration de ${GLib.path_get_basename(directory)} rechargée`);
  } catch (e) {
    toast(`Rechargement impossible : ${errorMessage(e)}`);
  }
}

/** Recharge la configuration du projet ; demande confirmation si des sessions y sont en cours. */
export function reloadProjectConfig(from: Gtk.Widget, client: OpencodeClient, directory: string, working: number, toast: (m: string) => void): void {
  if (working === 0) {
    void reload(client, directory, toast);
    return;
  }
  const dialog = new Adw.AlertDialog({
    heading: 'Recharger la configuration ?',
    body: `${working === 1 ? 'Une session est en cours' : `${working} sessions sont en cours`} dans ce projet : ${working === 1 ? 'sa réponse risque' : 'leurs réponses risquent'} d'être interrompue${working === 1 ? '' : 's'}.`,
    defaultResponse: 'cancel',
    closeResponse: 'cancel',
  });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('reload', 'Recharger');
  dialog.set_response_appearance('reload', Adw.ResponseAppearance.DESTRUCTIVE);
  dialog.connect('response', (_d: Adw.AlertDialog, response: string) => {
    if (response === 'reload') void reload(client, directory, toast);
  });
  dialog.present(from);
}
