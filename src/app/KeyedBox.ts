// Conteneur dont les enfants suivent une liste réactive, dans l'ordre exact de la liste.
// (<For> de gnim ajoute les nouveaux éléments à la fin, sans insertion à un index.)
// Chaque enfant vit dans sa propre racine gnim, libérée quand l'élément disparaît.
import Gtk from 'gi://Gtk?version=4.0';
import { createRoot, type Accessor } from 'gnim';

interface Child {
  readonly widget: Gtk.Widget;
  readonly dispose: () => void;
}

/** Opérations d'un conteneur ordonné : insérer à un index, retirer. */
interface Container {
  insert: (widget: Gtk.Widget, index: number) => void;
  remove: (widget: Gtk.Widget) => void;
}

function keyed<T>(container: Container, items: Accessor<readonly T[]>, key: (item: T) => string, render: (item: T) => Gtk.Widget): () => void {
  const children = new Map<string, Child>();
  /** ordre actuel des clés dans le conteneur */
  let order: string[] = [];

  const sync = (): void => {
    const list = items.peek();
    const keys = list.map((it) => key(it));
    const wanted = new Set(keys);
    for (const [k, c] of children) {
      if (!wanted.has(k)) {
        container.remove(c.widget);
        c.dispose();
        children.delete(k);
      }
    }
    order = order.filter((k) => wanted.has(k));
    list.forEach((it, index) => {
      const k = keys[index] ?? '';
      let c = children.get(k);
      if (c === undefined) {
        c = createRoot((dispose) => ({ widget: render(it), dispose }));
        children.set(k, c);
        container.insert(c.widget, index);
        order.splice(index, 0, k);
      } else if (order[index] !== k) {
        container.remove(c.widget);
        order.splice(order.indexOf(k), 1);
        container.insert(c.widget, index);
        order.splice(index, 0, k);
      }
    });
  };

  sync();
  const unsubscribe = items.subscribe(sync);
  return () => {
    unsubscribe();
    for (const c of children.values()) c.dispose();
    children.clear();
  };
}

/** Gtk.Box ordonné selon `items`. */
export function keyedBox<T>(box: Gtk.Box, items: Accessor<readonly T[]>, key: (item: T) => string, render: (item: T) => Gtk.Widget): () => void {
  return keyed(
    {
      insert: (w, index) => {
        let prev: Gtk.Widget | null = null;
        let c = box.get_first_child();
        for (let i = 0; i < index && c !== null; i += 1) {
          prev = c;
          c = c.get_next_sibling();
        }
        box.insert_child_after(w, prev);
      },
      remove: (w) => box.remove(w),
    },
    items,
    key,
    render,
  );
}

/** Gtk.ListBox ordonné selon `items` (sans fonction de tri). */
export function keyedListBox<T>(list: Gtk.ListBox, items: Accessor<readonly T[]>, key: (item: T) => string, render: (item: T) => Gtk.Widget): () => void {
  return keyed(
    {
      insert: (w, index) => list.insert(w, index),
      remove: (w) => list.remove(w instanceof Gtk.ListBoxRow ? w : (w.get_parent() ?? w)),
    },
    items,
    key,
    render,
  );
}
