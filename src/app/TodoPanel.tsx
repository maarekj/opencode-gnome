// Bandeau « Tâches » au-dessus du compositeur : liste de tâches de la session (outil `todowrite`).
// Replié : progression et tâche en cours ; déplié : liste complète. Masqué sans tâches.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createState, With, type Accessor } from 'gnim';
import { esc } from '../shared/format.ts';
import * as z from 'zod/mini';
import { Todo } from '../shared/schemas.ts';

const done = (t: Todo): boolean => t.status === 'completed';

/** « 3/7 · En cours : Écrire les tests » */
export function todoSummary(todos: readonly Todo[]): string {
  const total = todos.filter((t) => t.status !== 'cancelled').length;
  const progress = `${todos.filter((t) => done(t)).length}/${total}`;
  const current = todos.find((t) => t.status === 'in_progress');
  if (current !== undefined) return `${progress} · En cours : ${current.content}`;
  if (total > 0 && todos.every((t) => done(t) || t.status === 'cancelled')) return `${progress} · Terminé`;
  const next = todos.find((t) => t.status === 'pending');
  return next === undefined ? progress : `${progress} · À faire : ${next.content}`;
}

function TodoIcon({ status }: { status: string }): JSX.Element {
  switch (status) {
    case 'in_progress':
      return <Adw.Spinner widthRequest={16} heightRequest={16} tooltipText="En cours" />;
    case 'completed':
      return <Gtk.Image iconName="object-select-symbolic" cssClasses={['success']} tooltipText="Terminée" />;
    case 'cancelled':
      return <Gtk.Image iconName="window-close-symbolic" cssClasses={['dim-label']} tooltipText="Annulée" />;
    default:
      return <Gtk.Image iconName="radio-symbolic" cssClasses={['dim-label']} tooltipText="À faire" />;
  }
}

/** Tâches passées à `todowrite` (entrée) ou renvoyées par `todoread` (métadonnées). */
export function todosOfCall(input: unknown, metadata: unknown): Todo[] | null {
  for (const v of [input, metadata]) {
    const list = z.safeParse(TodoList, v);
    if (list.success) return list.data.todos;
  }
  return null;
}
const TodoList = z.looseObject({ todos: z.array(Todo) });

/** Lignes de tâches (détail d'un appel `todowrite`). */
export function TodoRows({ todos }: { todos: readonly Todo[] }): JSX.Element {
  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
      {todos.map((t) => (
        <TodoRow todo={t} />
      ))}
    </Gtk.Box>
  );
}

function TodoRow({ todo }: { todo: Todo }): JSX.Element {
  const cancelled = todo.status === 'cancelled';
  const markup = cancelled ? `<s>${esc(todo.content)}</s>` : esc(todo.content);
  return (
    <Gtk.Box spacing={8} cssClasses={['todo-row', todo.status]}>
      <TodoIcon status={todo.status} />
      <Gtk.Label
        label={markup}
        useMarkup
        xalign={0}
        hexpand
        wrap
        wrapMode={Pango.WrapMode.WORD_CHAR}
        cssClasses={cancelled || done(todo) ? ['dim-label'] : todo.status === 'in_progress' ? ['heading'] : []}
      />
      {todo.priority === 'high' ? <Gtk.Image iconName="emblem-important-symbolic" cssClasses={['dim-label']} pixelSize={12} tooltipText="Priorité haute" /> : null}
    </Gtk.Box>
  );
}

export function TodoPanel({ todos }: { todos: Accessor<readonly Todo[]> }): JSX.Element {
  const [expanded, setExpanded] = createState(false);
  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} cssClasses={['card', 'todo-panel']} marginStart={18} marginEnd={18} marginBottom={6} visible={todos((t) => t.length > 0)}>
      <Gtk.Button
        cssClasses={['flat', 'todo-header']}
        tooltipText={expanded((e) => (e ? 'Replier la liste de tâches' : 'Afficher la liste de tâches'))}
        onClicked={() => setExpanded(!expanded.peek())}
      >
        <Gtk.Box spacing={8}>
          <Gtk.Image iconName="view-list-bullet-symbolic" />
          <Gtk.Label label="Tâches" cssClasses={['heading']} />
          <Gtk.Label label={todos(todoSummary)} xalign={0} hexpand ellipsize={Pango.EllipsizeMode.END} cssClasses={['dim-label']} />
          <Gtk.Image iconName={expanded((e) => (e ? 'pan-down-symbolic' : 'pan-up-symbolic'))} />
        </Gtk.Box>
      </Gtk.Button>
      <Gtk.Revealer revealChild={expanded} transitionType={Gtk.RevealerTransitionType.SLIDE_UP}>
        <Gtk.ScrolledWindow hscrollbarPolicy={Gtk.PolicyType.NEVER} propagateNaturalHeight maxContentHeight={260}>
          {/* Box intermédiaire : la liste est reconstruite en entier à chaque mise à jour (quelques lignes) */}
          <Gtk.Box orientation={Gtk.Orientation.VERTICAL}>
            <With value={todos}>
              {(list: readonly Todo[]) => (
                <Gtk.Box marginStart={14} marginEnd={14} marginBottom={10} marginTop={2}>
                  <TodoRows todos={list} />
                </Gtk.Box>
              )}
            </With>
          </Gtk.Box>
        </Gtk.ScrolledWindow>
      </Gtk.Revealer>
    </Gtk.Box>
  );
}
