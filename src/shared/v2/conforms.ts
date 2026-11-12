// Vérification à la compilation : un schéma zod accepte toute valeur du type officiel
// d'OpenCode 2 (`@opencode/client`). Sans effet à l'exécution.
import type * as z from 'zod/mini';

/** `conforms<TypeOfficiel, typeof Schéma>(true)` : erreur de compilation si le schéma est plus strict. */
// oxlint-disable-next-line no-unnecessary-type-parameters -- T n'existe qu'à la compilation
export function conforms<T, S extends z.ZodMiniType>(ok: [T] extends [z.input<S>] ? true : false): void {
  void ok;
}
