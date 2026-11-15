// En tête de la barre latérale (#178) : sessions groupées par état (action requise, réponse à
// lire, en cours), avec le nom de leur projet ; l'arbre des projets suit.
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createComputed, onCleanup, type Accessor } from 'gnim';
import { fmtFullDate, fmtStamp } from '../shared/format.ts';
import type { Settings } from '../shared/settings.ts';
import { GROUP_ORDER, GROUP_TITLES, stateEntries, type StateEntry, type StateGroup } from '../shared/stategroups.ts';
import type { ProjectView } from '../shared/store.ts';
import { bindClasses } from './CssClass.ts';
import { attachContextMenu } from './ContextMenu.ts';
import { keyedListBox } from './KeyedBox.ts';
import { askDelete, askRename } from './SessionMenu.ts';
import { asWidget, normalize, treeActivity, type ProjectActions } from './Sidebar.tsx';

type Item = { readonly kind: 'group'; readonly group: StateGroup; readonly count: number } | ({ readonly kind: 'session' } & StateEntry);

const itemKey = (i: Item): string => (i.kind === 'group' ? `g:${i.group}` : `s:${i.view.session.id}`);

const titleOf = (e: StateEntry): string => (e.view.session.title === '' ? 'Sans titre' : e.view.session.title);
const updated = (e: StateEntry): number => e.view.session.time.updated;

function GroupRow({ item, live }: { item: Extract<Item, { kind: 'group' }>; live: Accessor<Item> }): JSX.Element {
  const count = live((i) => (i.kind === 'group' ? i.count : 0));
  return (
    <Gtk.ListBoxRow name={`g:${item.group}`} activatable={false} selectable={false} focusable={false} cssClasses={['state-group-row']}>
      <Gtk.Box spacing={6} marginStart={6} marginEnd={6}>
        <Gtk.Label label={GROUP_TITLES[item.group]} xalign={0} cssClasses={['heading', 'state-group-title']} />
        <Gtk.Label label={count(String)} cssClasses={['dim-label', 'caption']} />
      </Gtk.Box>
    </Gtk.ListBoxRow>
  );
}

function StateSessionRow({ item, live, actions, settings }: { item: StateEntry; live: Accessor<StateEntry>; actions: ProjectActions; settings: Settings }): JSX.Element {
  const s = item.view.session;
  const act = actions.sessionActions(s);
  const setAside = (): void => settings.setToRead(s.id, false);
  return (
    <Gtk.ListBoxRow
      name={`s:${s.id}`}
      cssClasses={['session-tree-row', 'state-session-row']}
      tooltipText={live((e) => `${titleOf(e)}\n${e.project.name} · ${fmtFullDate(updated(e))}${e.view.unread ? '\nRéponse non lue' : ''}`)}
      $={(self: Gtk.ListBoxRow) => {
        bindClasses(self, live, (e) => ({ unread: e.view.unread }));
        attachContextMenu(self, () => {
          const e = live.peek();
          return [
            e.group === 'toread' ? [{ label: 'Mettre de côté', activate: setAside }] : [],
            [
              { label: 'Ouvrir dans le terminal', activate: act.openInTerminal },
              { label: 'Renommer…', activate: () => askRename(self, titleOf(live.peek()), act.rename) },
              { label: 'Forker', activate: act.fork },
            ],
            e.open ? [{ label: 'Fermer', activate: () => actions.closeSession(s.id) }] : [],
            [{ label: 'Supprimer…', activate: () => askDelete(self, titleOf(live.peek()), act.delete) }],
          ].filter((section) => section.length > 0);
        });
      }}
    >
      <Gtk.Box spacing={8} marginStart={6} marginEnd={4}>
        <Gtk.Box
          widthRequest={16}
          valign={Gtk.Align.CENTER}
          $={(self: Gtk.Box) => {
            // indicateur remplacé seulement quand l'activité ou le non-lu change
            let shown = '';
            const update = (): void => {
              const v = live.peek().view;
              const k = `${v.activity}|${v.unread}`;
              if (k === shown) return;
              shown = k;
              for (let c = self.get_first_child(); c !== null; c = self.get_first_child()) self.remove(c);
              self.append(asWidget(treeActivity(v)));
            };
            update();
            onCleanup(live.subscribe(update));
          }}
        />
        <Gtk.Box orientation={Gtk.Orientation.VERTICAL} hexpand valign={Gtk.Align.CENTER}>
          <Gtk.Label label={live(titleOf)} xalign={0} ellipsize={Pango.EllipsizeMode.END} cssClasses={['session-title']} />
          <Gtk.Label label={live((e) => `${e.project.name} · ${fmtStamp(updated(e))}`)} xalign={0} ellipsize={Pango.EllipsizeMode.END} cssClasses={['dim-label', 'caption']} />
        </Gtk.Box>
        <Gtk.Button
          iconName="object-select-symbolic"
          tooltipText="Mettre de côté"
          visible={live((e) => e.group === 'toread')}
          valign={Gtk.Align.CENTER}
          cssClasses={['flat', 'circular', 'close-button']}
          onClicked={setAside}
        />
        <Gtk.Button
          iconName="window-close-symbolic"
          tooltipText="Fermer (Ctrl+W)"
          visible={live((e) => e.open)}
          valign={Gtk.Align.CENTER}
          cssClasses={['flat', 'circular', 'close-button']}
          onClicked={() => actions.closeSession(s.id)}
        />
      </Gtk.Box>
    </Gtk.ListBoxRow>
  );
}

/**
 * Liste de l'en-tête. `projects` : projets considérés ; `query` : recherche sur le
 * titre de la session, le nom et le chemin du projet.
 */
export function StatesList({
  settings,
  projects,
  query,
  actions,
}: {
  settings: Settings;
  projects: Accessor<readonly ProjectView[]>;
  query: Accessor<string>;
  actions: ProjectActions;
}): { list: Gtk.ListBox; empty: Accessor<boolean> } {
  const entries = createComputed((): readonly StateEntry[] => {
    const { openSessions, toRead } = settings.data();
    const q = normalize(query().trim());
    const all = stateEntries(projects(), openSessions, toRead);
    return q === '' ? all : all.filter((e) => normalize(`${titleOf(e)} ${e.project.name} ${e.project.path}`).includes(q));
  });
  const items = createComputed((): Item[] => {
    const out: Item[] = [];
    const list = entries();
    for (const group of GROUP_ORDER) {
      const inGroup = list.filter((e) => e.group === group);
      if (inGroup.length === 0) continue;
      out.push({ kind: 'group', group, count: inGroup.length });
      for (const e of inGroup) out.push({ kind: 'session', ...e });
    }
    return out;
  });
  // pas de sélection : la session affichée est mise en évidence dans l'arbre seulement
  const list = new Gtk.ListBox({ cssClasses: ['navigation-sidebar', 'states-list'], selectionMode: Gtk.SelectionMode.NONE });
  list.update_property([Gtk.AccessibleProperty.LABEL], ['Sessions par état']);
  list.connect('row-activated', (_l: Gtk.ListBox, row: Gtk.ListBoxRow) => {
    if (row.name.startsWith('s:')) actions.openSession(row.name.slice(2));
  });
  onCleanup(
    keyedListBox(list, items, itemKey, (i, live) => {
      if (i.kind === 'group') return asWidget(GroupRow({ item: i, live }));
      const fallback: StateEntry = i;
      return asWidget(StateSessionRow({ item: i, live: live((x) => (x.kind === 'session' ? x : fallback)), actions, settings }));
    }),
  );
  return { list, empty: entries((e) => e.length === 0) };
}
