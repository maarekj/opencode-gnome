// Pastilles des terminaux persistants d'un projet (zellij) + bouton d'ajout.
// Premier clic : démarre la commande et ouvre le terminal ; ensuite : rouvre la session en cours.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createComputed, onCleanup, type Accessor } from 'gnim';
import { errorMessage } from '../shared/errors.ts';
import { prettyPath } from '../shared/store.ts';
import type { ProjectTerminal, Settings } from '../shared/settings.ts';
import { terminalId, zellijInstalled, type TerminalManager } from '../shared/terminals.ts';
import { attachContextMenu } from './ContextMenu.ts';
import { keyedBox } from './KeyedBox.ts';

export interface TerminalContext {
  readonly settings: Settings;
  readonly manager: TerminalManager;
  readonly toast: (message: string) => void;
}

const attempt = (ctx: TerminalContext, what: string, fn: () => Promise<void>): void => {
  fn().catch((e: unknown) => ctx.toast(`${what} : ${errorMessage(e)}`));
};

/** Dialogue d'ajout (`current` absent) ou de modification d'un terminal. */
function askTerminal(parent: Gtk.Widget, project: string, ctx: TerminalContext, current?: ProjectTerminal): void {
  const name = new Adw.EntryRow({ title: 'Nom', text: current?.name ?? '' });
  const command = new Adw.EntryRow({ title: 'Commande (vide : simple shell)', text: current?.command ?? '' });
  const cwd = new Adw.EntryRow({ title: 'Répertoire, relatif au projet (optionnel, ex. packages/web)', text: current?.cwd ?? '' });
  const group = new Adw.PreferencesGroup();
  for (const row of [name, command, cwd]) group.add(row);
  const dialog = new Adw.AlertDialog({
    heading: current === undefined ? 'Nouveau terminal' : 'Modifier le terminal',
    body: `La commande tourne dans une session zellij : fermer la fenêtre du terminal ne l’arrête pas. Elle est lancée depuis ${prettyPath(project)}, ou depuis le sous-dossier indiqué (chemin absolu ou ~/… aussi acceptés).`,
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
    });
  });
  dialog.present(parent);
  name.grab_focus();
}

function askRemove(parent: Gtk.Widget, project: string, t: ProjectTerminal, ctx: TerminalContext): void {
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
export function terminalActions(t: ProjectTerminal, project: string, ctx: TerminalContext): { open: () => void; restart: () => void; stop: () => void } {
  return {
    open: () => attempt(ctx, 'Ouverture impossible', () => ctx.manager.open(t, project)),
    restart: () => attempt(ctx, 'Redémarrage impossible', () => ctx.manager.restart(t, project)),
    stop: () => attempt(ctx, 'Arrêt impossible', () => ctx.manager.stop(t)),
  };
}

/** Menu contextuel d'un terminal (ouvrir, redémarrer / arrêter ou démarrer, modifier, supprimer). */
export function attachTerminalMenu(widget: Gtk.Widget, t: ProjectTerminal, project: string, ctx: TerminalContext): void {
  const act = terminalActions(t, project, ctx);
  attachContextMenu(widget, () => [
    [
      { label: 'Ouvrir', activate: act.open },
      ...(ctx.manager.isRunning(t.id)
        ? [
            { label: 'Redémarrer', activate: act.restart },
            { label: 'Arrêter', activate: act.stop },
          ]
        : [{ label: 'Démarrer en arrière-plan', activate: () => attempt(ctx, 'Démarrage impossible', () => ctx.manager.start(t, project)) }]),
    ],
    [
      { label: 'Modifier…', activate: () => askTerminal(widget, project, ctx, t) },
      { label: 'Supprimer…', activate: () => askRemove(widget, project, t, ctx) },
    ],
  ]);
}

/**
 * Terminal en cours, sous son projet dans la barre latérale : nom, pastille verte, redémarrer /
 * arrêter au survol. Activer la ligne (nom `t:<projet>\n<id>`) ouvre le terminal.
 */
export function TerminalTreeRow({ t, project, last, ctx }: { t: ProjectTerminal; project: string; last: boolean; ctx: TerminalContext }): Gtk.Widget {
  const act = terminalActions(t, project, ctx);
  const row = (
    <Gtk.ListBoxRow
      name={`t:${project}\n${t.id}`}
      cssClasses={last ? ['session-tree-row', 'terminal-tree-row', 'last'] : ['session-tree-row', 'terminal-tree-row']}
      tooltipText={`${t.name} : ${t.command === '' ? 'shell' : t.command}\nEn cours : clic pour ouvrir le terminal`}
      $={(self: Gtk.ListBoxRow) => attachTerminalMenu(self, t, project, ctx)}
    >
      <Gtk.Box spacing={8} marginStart={34} marginEnd={4} cssClasses={['session-tree-inner']}>
        <Gtk.Image iconName="utilities-terminal-symbolic" pixelSize={16} valign={Gtk.Align.CENTER} />
        <Gtk.Label label={t.name} hexpand xalign={0} ellipsize={Pango.EllipsizeMode.END} cssClasses={['session-title']} />
        <Gtk.Box cssClasses={['terminal-dot']} valign={Gtk.Align.CENTER} tooltipText="En cours" />
        <Gtk.Button iconName="view-refresh-symbolic" tooltipText="Redémarrer" valign={Gtk.Align.CENTER} cssClasses={['flat', 'circular', 'close-button']} onClicked={act.restart} />
        <Gtk.Button iconName="media-playback-stop-symbolic" tooltipText="Arrêter" valign={Gtk.Align.CENTER} cssClasses={['flat', 'circular', 'close-button', 'terminal-stop']} onClicked={act.stop} />
      </Gtk.Box>
    </Gtk.ListBoxRow>
  );
  if (!(row instanceof Gtk.Widget)) throw new TypeError('widget attendu');
  return row;
}

function TerminalPill({ t, project, running, ctx }: { t: ProjectTerminal; project: string; running: boolean; ctx: TerminalContext }): Gtk.Widget {
  const { open, restart, stop } = terminalActions(t, project, ctx);
  const widget = (
    <Gtk.Button
      cssClasses={running ? ['terminal-pill', 'running'] : ['terminal-pill']}
      tooltipText={`${t.command === '' ? 'Shell' : t.command}\n${running ? 'En cours : clic pour ouvrir le terminal' : 'Arrêté : clic pour démarrer'}`}
      onClicked={open}
      $={(self: Gtk.Button) => attachTerminalMenu(self, t, project, ctx)}
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

/** Barre des terminaux du projet `project` (masquée sans projet ou sans zellij). */
export function TerminalBar({ project, ctx }: { project: Accessor<string | null>; ctx: TerminalContext }): JSX.Element {
  const items = createComputed(() => {
    const p = project();
    if (p === null) return [];
    const running = ctx.manager.running();
    return (ctx.settings.data().terminals[p] ?? []).map((t) => ({ t, project: p, running: running.has(t.id) }));
  });
  ctx.manager.watch();
  return (
    <Gtk.Box spacing={6} cssClasses={['terminal-bar']} visible={project((p) => p !== null && zellijInstalled())}>
      <Gtk.ScrolledWindow hexpand={false} vscrollbarPolicy={Gtk.PolicyType.NEVER} hscrollbarPolicy={Gtk.PolicyType.AUTOMATIC} propagateNaturalWidth>
        <Gtk.Box
          spacing={6}
          $={(self: Gtk.Box) => {
            onCleanup(
              keyedBox(
                self,
                items,
                (i) => `${i.project}|${i.t.id}|${i.t.name}|${i.t.command}|${i.t.cwd ?? ''}|${i.running}`,
                (i) => TerminalPill({ ...i, ctx }),
              ),
            );
          }}
        />
      </Gtk.ScrolledWindow>
      <Gtk.Button
        iconName="list-add-symbolic"
        tooltipText="Ajouter un terminal persistant (devenv up, pnpm dev…)"
        cssClasses={['flat', 'circular', 'terminal-add']}
        onClicked={(self: Gtk.Button) => {
          const p = project.peek();
          if (p !== null) askTerminal(self, p, ctx);
        }}
      />
      <Gtk.Label label="Terminaux" cssClasses={['dim-label', 'caption']} visible={items((l) => l.length === 0)} />
    </Gtk.Box>
  );
}
