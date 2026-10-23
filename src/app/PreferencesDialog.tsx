// Préférences : terminal et modèle par défaut (enregistrés dans settings.json, cf. src/shared/settings.ts).
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import type { Providers } from '../shared/schemas.ts';
import type { Settings } from '../shared/settings.ts';
import { automaticTerminal, installedTerminals } from '../shared/terminal.ts';

const AUTO = 'auto';
const CUSTOM = 'custom';

/** ComboRow de chaînes : `ids` (valeurs enregistrées) et `labels` (affichés), recherche optionnelle. */
function comboRow(title: string, subtitle: string, search: boolean): Adw.ComboRow {
  const row = new Adw.ComboRow({ title, subtitle, enableSearch: search, useSubtitle: false });
  if (search) row.expression = Gtk.PropertyExpression.new(Gtk.StringObject.$gtype, null, 'string');
  return row;
}

function setItems(row: Adw.ComboRow, labels: readonly string[], index: number): void {
  row.model = Gtk.StringList.new([...labels]);
  row.selected = Math.max(0, index);
}

/** Groupe « Terminal ». */
function terminalGroup(settings: Settings): Adw.PreferencesGroup {
  const group = new Adw.PreferencesGroup({
    title: 'Terminal',
    description: "Utilisé par « Ouvrir dans le terminal » (opencode attach) et « Ouvrir opencode dans le terminal ».",
  });
  const auto = automaticTerminal();
  const installed = installedTerminals();
  const current = settings.data.peek();
  // terminal enregistré mais plus installé : conservé dans la liste
  const names = [...new Set([...installed, ...(current.terminal !== undefined && current.terminal !== CUSTOM ? [current.terminal] : [])])];
  const ids = [AUTO, ...names, CUSTOM];
  const labels = [`Automatique (${auto ?? 'aucun trouvé'})`, ...names.map((n) => (installed.includes(n) ? n : `${n} (non installé)`)), 'Personnalisé…'];

  const row = comboRow('Terminal', '', false);
  setItems(row, labels, ids.indexOf(current.terminal ?? AUTO));
  const custom = new Adw.EntryRow({ title: 'Commande du terminal (ex. foot -e)', text: current.terminalCommand ?? '' });
  custom.visible = current.terminal === CUSTOM;

  row.connect('notify::selected', () => {
    const id = ids[row.selected] ?? AUTO;
    settings.setOptional('terminal', id === AUTO ? undefined : id);
    custom.visible = id === CUSTOM;
  });
  // enregistré à chaque frappe : rien à valider
  custom.connect('changed', () => {
    const text = custom.text.trim();
    settings.setOptional('terminalCommand', text === '' ? undefined : text);
  });
  group.add(row);
  group.add(custom);
  return group;
}

/** Groupe « Modèle par défaut » (sessions sans modèle : nouvelles sessions, forks). */
function modelGroup(settings: Settings, providers: Promise<Providers>): Adw.PreferencesGroup {
  const group = new Adw.PreferencesGroup({
    title: 'Modèle par défaut',
    description:
      'Présélectionné pour une nouvelle session ; les sessions existantes gardent leur modèle. Automatique : modèle de la config opencode, sinon défaut du fournisseur.',
  });
  const modelRow = comboRow('Modèle', '', true);
  const variantRow = comboRow('Niveau de raisonnement', '', false);
  setItems(modelRow, ['Chargement…'], 0);
  modelRow.sensitive = false;
  variantRow.visible = false;
  group.add(modelRow);
  group.add(variantRow);

  const fill = (p: Providers): void => {
    const models: string[] = p.providers.flatMap((prov) => Object.keys(prov.models).map((id) => `${prov.id}/${id}`)).toSorted();
    const variants = new Map<string, string[]>(p.providers.flatMap((prov) => Object.entries(prov.models).map(([id, m]): [string, string[]] => [`${prov.id}/${id}`, Object.keys(m.variants ?? {})])));
    const ids: string[] = [AUTO, ...models];
    const saved = settings.data.peek().defaultModel;
    setItems(modelRow, ['Automatique', ...models], saved !== undefined && models.includes(saved) ? ids.indexOf(saved) : 0);
    modelRow.sensitive = true;

    let variantIds: string[] = [];
    const fillVariants = (): void => {
      const model = ids[modelRow.selected] ?? AUTO;
      const list = model === AUTO ? [] : (variants.get(model) ?? []);
      variantIds = ['', ...list];
      const wanted = settings.data.peek().defaultVariant;
      setItems(variantRow, ['Par défaut', ...list], wanted !== undefined && list.includes(wanted) ? variantIds.indexOf(wanted) : 0);
      variantRow.visible = list.length > 0;
    };
    fillVariants();

    modelRow.connect('notify::selected', () => {
      const id = ids[modelRow.selected] ?? AUTO;
      settings.setOptional('defaultModel', id === AUTO ? undefined : id);
      fillVariants();
      // variante absente du nouveau modèle : retour à « Par défaut »
      const v = variantIds[variantRow.selected] ?? '';
      settings.setOptional('defaultVariant', v === '' ? undefined : v);
    });
    variantRow.connect('notify::selected', () => {
      const v = variantIds[variantRow.selected] ?? '';
      settings.setOptional('defaultVariant', v === '' ? undefined : v);
    });
  };
  providers.then(fill, () => {
    setItems(modelRow, ['Serveur opencode injoignable'], 0);
  });
  return group;
}

export function openPreferences(parent: Gtk.Widget, settings: Settings, providers: Promise<Providers>): void {
  const page = new Adw.PreferencesPage({ title: 'Général', iconName: 'preferences-system-symbolic' });
  page.add(terminalGroup(settings));
  page.add(modelGroup(settings, providers));
  const dialog = new Adw.PreferencesDialog({ title: 'Préférences', searchEnabled: false });
  dialog.add(page);
  dialog.present(parent);
}
