// Valeur réactive suspendue tant qu'une page n'est pas affichée (#161) : les changements de la
// source sont ignorés pendant ce temps, la dernière valeur est appliquée au retour à l'écran.
import { createState, onCleanup, type Accessor } from 'gnim';

export function paused<T>(source: Accessor<T>, active: Accessor<boolean>): Accessor<T> {
  const [value, setValue] = createState(source.peek());
  let stale = false;
  const unsubscribe = [
    source.subscribe(() => {
      if (active.peek()) setValue(source.peek());
      else stale = true;
    }),
    active.subscribe(() => {
      if (!active.peek() || !stale) return;
      stale = false;
      setValue(source.peek());
    }),
  ];
  onCleanup(() => {
    for (const u of unsubscribe) u();
  });
  return value;
}
