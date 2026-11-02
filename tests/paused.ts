// #161 : sur une page cachée, l'affichage ne suit plus la conversation ; rattrapage au retour.
import { createRoot, createState } from 'gnim';
import { paused } from '../src/app/Paused.ts';

const errors: string[] = [];
createRoot(() => {
  const [source, setSource] = createState(['a']);
  const [active, setActive] = createState(true);
  const shown = paused(source, active);
  let renders = 0;
  shown.subscribe(() => {
    renders += 1;
  });
  setSource(['a', 'b']);
  if (shown.peek().join() !== 'a,b' || renders !== 1) errors.push(`page affichée : ${shown.peek().join()} / ${renders}`);
  setActive(false);
  setSource(['a', 'b', 'c']);
  setSource(['a', 'b', 'c', 'd']);
  if (shown.peek().join() !== 'a,b' || renders !== 1) errors.push(`page cachée : aucun rendu attendu (${shown.peek().join()} / ${renders})`);
  setActive(true);
  if (shown.peek().join() !== 'a,b,c,d' || renders !== 2) errors.push(`retour : un seul rendu, état complet attendu (${shown.peek().join()} / ${renders})`);
  setActive(false);
  setActive(true);
  if (renders !== 2) errors.push('retour sans changement : aucun rendu attendu');
});
print(errors.length === 0 ? 'TEST OK' : errors.join('\n'));
