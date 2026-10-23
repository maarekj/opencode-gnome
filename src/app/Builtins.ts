// Commandes « / » propres à l'app, équivalentes aux commandes intégrées de la TUI
// (sans entrée dans `GET /command`) : réalisées avec les routes de session existantes.
import Gdk from 'gi://Gdk?version=4.0';
import type Gtk from 'gi://Gtk?version=4.0';
import type { OpencodeClient } from '../shared/client.ts';
import type { Session } from '../shared/schemas.ts';
import type { BuiltinCommand } from './Composer.tsx';
import { askRename, type SessionActions } from './SessionMenu.ts';

export interface BuiltinContext {
  readonly client: OpencodeClient;
  readonly sessionID: string;
  readonly dir: () => string;
  readonly session: () => Session | undefined;
  /** messages de l'utilisateur, du plus ancien au plus récent */
  readonly userMessages: () => readonly { id: string; text: string }[];
  readonly toast: (message: string) => void;
  readonly newSession: (directory: string) => void;
  readonly sessionActions: (session: Session) => SessionActions;
  readonly attach: (directory: string, sessionID?: string) => void;
  /** widget parent des dialogues */
  readonly parent: () => Gtk.Widget;
}

const required = (s: Session | undefined): Session => {
  if (s === undefined) throw new Error('session introuvable');
  return s;
};

export function builtinCommands(ctx: BuiltinContext): BuiltinCommand[] {
  const { client, sessionID, dir, toast } = ctx;
  return [
    {
      name: 'compact',
      description: 'Compacter la session (résumé du contexte)',
      run: async (_args, choice) => {
        if (choice.model === undefined) throw new Error('aucun modèle sélectionné');
        toast('Compactage de la session…');
        await client.summarize(sessionID, dir(), choice.model);
        return null;
      },
    },
    {
      name: 'undo',
      description: 'Annuler le dernier message (et ses modifications de fichiers)',
      run: async () => {
        const revert = ctx.session()?.revert?.messageID;
        const target = ctx.userMessages().findLast((m) => revert === undefined || m.id < revert);
        if (target === undefined) throw new Error('rien à annuler');
        await client.revert(sessionID, dir(), target.id);
        toast('Message annulé');
        // comme la TUI : le prompt annulé revient dans la zone de saisie
        return target.text === '' ? null : target.text;
      },
    },
    {
      name: 'redo',
      description: 'Rétablir le message annulé',
      run: async () => {
        const revert = ctx.session()?.revert?.messageID;
        if (revert === undefined) throw new Error('rien à rétablir');
        const next = ctx.userMessages().find((m) => m.id > revert);
        if (next === undefined) await client.unrevert(sessionID, dir());
        else await client.revert(sessionID, dir(), next.id);
        toast('Message rétabli');
        return null;
      },
    },
    {
      name: 'new',
      description: 'Nouvelle session dans ce projet',
      run: () => {
        ctx.newSession(dir());
        return Promise.resolve(null);
      },
    },
    {
      name: 'share',
      description: 'Partager la session (lien copié)',
      run: async () => {
        const url = await client.share(sessionID, dir());
        if (url === null) throw new Error('aucun lien retourné');
        Gdk.Display.get_default()?.get_clipboard().set(url);
        toast('Lien de partage copié');
        return null;
      },
    },
    {
      name: 'unshare',
      description: 'Ne plus partager la session',
      run: async () => {
        await client.unshare(sessionID, dir());
        toast('Session plus partagée');
        return null;
      },
    },
    {
      name: 'rename',
      description: 'Renommer la session',
      hints: '[titre]',
      run: (args) => {
        const s = required(ctx.session());
        const actions = ctx.sessionActions(s);
        if (args === '') askRename(ctx.parent(), s.title, actions.rename);
        else actions.rename(args);
        return Promise.resolve(null);
      },
    },
    {
      name: 'fork',
      description: 'Copier la session dans une nouvelle session',
      run: () => {
        ctx.sessionActions(required(ctx.session())).fork();
        return Promise.resolve(null);
      },
    },
    {
      name: 'terminal',
      description: 'Ouvrir la session dans le terminal',
      run: () => {
        ctx.attach(dir(), sessionID);
        return Promise.resolve(null);
      },
    },
  ];
}
