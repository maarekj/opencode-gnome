// Terminaux persistants d'un projet (zellij) : pastille, actions, menu, dialogues (barre : ProjectBar).
// Premier clic : démarre la commande et ouvre le terminal ; ensuite : rouvre la session en cours.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { errorMessage } from '../shared/errors.ts';
import { prettyPath } from '../shared/store.ts';
import type { ProjectTerminal, Settings } from '../shared/settings.ts';
import { attachArgv, cwdOf, terminalId, type TerminalManager } from '../shared/terminals.ts';
import { attachContextMenu, hosted, type MenuHost, type MenuItem } from './ContextMenu.ts';
import { currentFolder, folderChooser } from './FolderChoice.ts';
import type { TerminalDock } from './TerminalPanel.tsx';

export interface TerminalContext {
  readonly settings: Settings;
  readonly manager: TerminalManager;
  readonly toast: (message: string) => void;
  /** terminal intégré (panneau sous la zone principale) */
  readonly dock: TerminalDock;
}

const attempt = (ctx: TerminalContext, what: string, fn: () => Promise<void>): void => {
  fn().catch((e: unknown) => ctx.toast(`${what} : ${errorMessage(e)}`));
};

/**
 * Dialogue d'ajout (`current` absent) ou de modification d'un terminal ; `folder` : dossier
 * proposé pour un nouveau terminal.
 */
export function askTerminal(parent: Gtk.Widget, project: string, ctx: TerminalContext, current?: ProjectTerminal, folder: string | null = null): void {
  const name = new Adw.EntryRow({ title: 'Nom', text: current?.name ?? '' });
  const command = new Adw.EntryRow({ title: 'Commande (vide : simple shell)', text: current?.command ?? '' });
  const cwd = new Adw.EntryRow({ title: 'Répertoire, relatif au projet (optionnel, ex. packages/web)', text: current?.cwd ?? '' });
  const group = new Adw.PreferencesGroup();
  for (const row of [name, command, cwd]) group.add(row);
  const place = folderChooser(ctx.settings, project, current === undefined ? folder : currentFolder(ctx.settings, project, `terminal:${current.id}`));
  if (place.row !== null) group.add(place.row);
  const dialog = new Adw.AlertDialog({
    heading: current === undefined ? 'Nouveau terminal' : 'Modifier le terminal',
    body: `La commande tourne dans une session zellij : fermer son onglet ou la fenêtre du terminal ne l’arrête pas. Elle est lancée depuis ${prettyPath(project)}, ou depuis le sous-dossier indiqué (chemin absolu ou ~/… aussi acceptés).`,
    extraChild: group,
    defaultResponse: 'save',
    closeResponse: 'cancel',
  });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('save', current === undefined ? 'Ajouter' : 'Enregistrer');
  dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
  const valid = (): boolean => name.text.trim() !== '';
  const update = (): void => dialog.set_response_enabled('save', valid());
  name.connect('changed', update);
  command.connect('changed', update);
  update();
  dialog.connect('response', (_d: Adw.AlertDialog, response: string) => {
    if (response !== 'save' || !valid()) return;
    const taken = Object.values(ctx.settings.data.peek().terminals)
      .flat()
      .map((t) => t.id);
    const dir = cwd.text.trim();
    ctx.settings.saveTerminal(project, {
      id: current?.id ?? terminalId(project, name.text.trim(), taken),
      name: name.text.trim(),
      command: command.text.trim(),
      ...(dir === '' ? {} : { cwd: dir }),
    }, place.value());
  });
  dialog.present(parent);
  name.grab_focus();
}

export function askRemoveTerminal(parent: Gtk.Widget, project: string, t: ProjectTerminal, ctx: TerminalContext): void {
  const dialog = new Adw.AlertDialog({
    heading: 'Supprimer le terminal ?',
    body: `« ${t.name} » sera retiré du projet${ctx.manager.isRunning(t.id) ? ' et sa commande arrêtée' : ''}.`,
    defaultResponse: 'cancel',
    closeResponse: 'cancel',
  });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('delete', 'Supprimer');
  dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
  dialog.connect('response', (_d: Adw.AlertDialog, response: string) => {
    if (response !== 'delete') return;
    ctx.settings.removeTerminal(project, t.id);
    attempt(ctx, 'Arrêt impossible', () => ctx.manager.stop(t));
  });
  dialog.present(parent);
}

/** Actions d'un terminal, partagées par la pastille et la ligne de la barre latérale. */
export function terminalActions(t: ProjectTerminal, project: string, ctx: TerminalContext): { open: () => void; external: () => void; restart: () => void; stop: () => void } {
  const external = (): void => attempt(ctx, 'Ouverture impossible', () => ctx.manager.open(t, project));
  return {
    // terminal intégré : onglet attaché à la session zellij (fermer l'onglet détache)
    open: () =>
      ctx.dock.enabled()
        ? attempt(ctx, 'Ouverture impossible', async () => {
            await ctx.manager.ensure(t, project);
            ctx.dock.open(project, {
              key: `zellij:${t.id}`,
              title: t.name,
              tooltip: `${t.name} : ${t.command === '' ? 'shell' : t.command}\nSession zellij ${t.id} : fermer l’onglet la laisse tourner`,
              icon: 'utilities-terminal-symbolic',
              argv: attachArgv(t),
              cwd: cwdOf(t, project),
              external,
            });
          })
        : external(),
    external,
    restart: () => attempt(ctx, 'Redémarrage impossible', () => ctx.manager.restart(t, project)),
    stop: () => attempt(ctx, 'Arrêt impossible', () => ctx.manager.stop(t)),
  };
}

/** Menu contextuel d'un terminal (ouvrir, redémarrer / arrêter ou démarrer, modifier, supprimer). */
export function attachTerminalMenu(widget: Gtk.Widget, t: ProjectTerminal, project: string, ctx: TerminalContext, extra: () => readonly (readonly MenuItem[])[] = () => [], host?: MenuHost): void {
  const act = terminalActions(t, project, ctx);
  const anchor = host?.anchor ?? widget;
  attachContextMenu(widget, () => hosted(host, [
    [
      { label: 'Ouvrir', activate: act.open },
      ...(ctx.dock.enabled() ? [{ label: 'Ouvrir dans le terminal externe', activate: act.external }] : []),
      ...(ctx.manager.isRunning(t.id)
        ? [
            { label: 'Redémarrer', activate: act.restart },
            { label: 'Arrêter', activate: act.stop },
          ]
        : [{ label: 'Démarrer en arrière-plan', activate: () => attempt(ctx, 'Démarrage impossible', () => ctx.manager.start(t, project)) }]),
    ],
    [
      { label: 'Modifier…', activate: () => askTerminal(anchor, project, ctx, t) },
      { label: 'Supprimer…', activate: () => askRemoveTerminal(anchor, project, t, ctx) },
    ],
    ...extra(),
  ]));
}

export function TerminalPill({ t, project, running, ctx, extra }: { t: ProjectTerminal; project: string; running: boolean; ctx: TerminalContext; extra?: () => readonly (readonly MenuItem[])[] }): Gtk.Widget {
  const { open, restart, stop } = terminalActions(t, project, ctx);
  const widget = (
    <Gtk.Button
      cssClasses={running ? ['terminal-pill', 'running'] : ['terminal-pill']}
      tooltipText={`${t.command === '' ? 'Shell' : t.command}\n${running ? 'En cours : clic pour ouvrir le terminal' : 'Arrêté : clic pour démarrer'}`}
      onClicked={open}
      $={(self: Gtk.Button) => attachTerminalMenu(self, t, project, ctx, extra)}
    >
      <Gtk.Box spacing={6}>
        <Gtk.Image iconName="utilities-terminal-symbolic" pixelSize={14} />
        <Gtk.Label label={t.name} />
        {running ? <Gtk.Box cssClasses={['terminal-dot']} valign={Gtk.Align.CENTER} tooltipText="En cours" /> : null}
      </Gtk.Box>
    </Gtk.Button>
  );
  if (!(widget instanceof Gtk.Widget)) throw new TypeError('widget attendu');
  if (!running) return widget;
  // terminal en cours : bouton divisé (ouvrir | redémarrer | arrêter)
  const split = (
    <Gtk.Box cssClasses={['linked', 'terminal-split']} valign={Gtk.Align.CENTER}>
      {widget}
      <Gtk.Button
        iconName="view-refresh-symbolic"
        tooltipText="Redémarrer"
        cssClasses={['terminal-pill', 'running', 'terminal-action']}
        onClicked={restart}
      />
      <Gtk.Button
        iconName="media-playback-stop-symbolic"
        tooltipText="Arrêter"
        cssClasses={['terminal-pill', 'running', 'terminal-action', 'terminal-stop']}
        onClicked={stop}
      />
    </Gtk.Box>
  );
  if (!(split instanceof Gtk.Widget)) throw new TypeError('widget attendu');
  return split;
}
