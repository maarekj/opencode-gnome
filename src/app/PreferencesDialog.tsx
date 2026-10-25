// Préférences : terminal et modèle par défaut (enregistrés dans settings.json, cf. src/shared/settings.ts).
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import type { Providers } from '../shared/schemas.ts';
import { createRoot } from 'gnim';
import { DEFAULT_MARKDOWN_STYLE, type Settings, type Theme } from '../shared/settings.ts';
import { MarkdownView } from './Markdown.tsx';
import { automaticIde, installedIdes } from './Ide.ts';
import { automaticTerminal, installedTerminals } from '../shared/terminal.ts';
import { integratedAvailable } from './TerminalPanel.tsx';

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
    description: 'Terminaux des sessions (opencode attach), du projet et terminaux persistants.',
  });
  const integrated = new Adw.SwitchRow({
    title: 'Terminal intégré',
    subtitle: integratedAvailable() ? 'Ouvrir les terminaux dans un panneau de la fenêtre (le terminal externe reste accessible depuis le panneau)' : 'Indisponible : bibliothèque VTE (GTK 4) introuvable',
    active: settings.data.peek().terminalIntegrated && integratedAvailable(),
    sensitive: integratedAvailable(),
  });
  integrated.connect('notify::active', () => settings.setTerminalIntegrated(integrated.active));
  group.add(integrated);
  const auto = automaticTerminal();
  const installed = installedTerminals();
  const current = settings.data.peek();
  // terminal enregistré mais plus installé : conservé dans la liste
  const names = [...new Set([...installed, ...(current.terminal !== undefined && current.terminal !== CUSTOM ? [current.terminal] : [])])];
  const ids = [AUTO, ...names, CUSTOM];
  const labels = [`Automatique (${auto ?? 'aucun trouvé'})`, ...names.map((n) => (installed.includes(n) ? n : `${n} (non installé)`)), 'Personnalisé…'];

  const row = comboRow('Terminal externe', '', false);
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

/** Groupe « Taille et largeur » : taille du texte et largeur de la conversation, appliquées en direct. */
function sizeGroup(settings: Settings): Adw.PreferencesGroup {
  const group = new Adw.PreferencesGroup({ title: 'Taille et largeur' });
  const d = settings.data.peek();
  const font = new Adw.SpinRow({
    title: 'Taille du texte',
    subtitle: 'En % de la taille normale',
    adjustment: new Gtk.Adjustment({ lower: 70, upper: 200, stepIncrement: 5, pageIncrement: 10, value: d.fontScale }),
  });
  font.connect('notify::value', () => settings.setNumber('fontScale', Math.round(font.value)));
  const full = new Adw.SwitchRow({ title: 'Toute la largeur', subtitle: 'La conversation occupe toute la largeur de la fenêtre', active: d.maxWidth <= 0 });
  const width = new Adw.SpinRow({
    title: 'Largeur maximale',
    subtitle: 'En pixels',
    sensitive: d.maxWidth > 0,
    adjustment: new Gtk.Adjustment({ lower: 400, upper: 3000, stepIncrement: 20, pageIncrement: 100, value: d.maxWidth <= 0 ? 860 : d.maxWidth }),
  });
  width.connect('notify::value', () => {
    if (!full.active) settings.setNumber('maxWidth', Math.round(width.value));
  });
  full.connect('notify::active', () => {
    width.sensitive = !full.active;
    settings.setNumber('maxWidth', full.active ? 0 : Math.round(width.value));
  });
  group.add(font);
  group.add(full);
  group.add(width);
  return group;
}

/** Groupe « Conversation » : notifications. */
function conversationGroup(settings: Settings): Adw.PreferencesGroup {
  const group = new Adw.PreferencesGroup({ title: 'Conversation' });
  const d = settings.data.peek();
  const notify = new Adw.SwitchRow({
    title: 'Notifications',
    subtitle: 'Session terminée, question, permission demandée ou erreur (application ouverte)',
    active: d.notifications,
  });
  const sound = new Adw.SwitchRow({
    title: 'Son',
    subtitle: 'Avec chaque notification ; si la session est déjà affichée, seulement un son discret',
    active: d.notificationSound,
    sensitive: d.notifications,
  });
  notify.connect('notify::active', () => {
    settings.setNotifications(notify.active);
    sound.sensitive = notify.active;
  });
  sound.connect('notify::active', () => settings.setNotificationSound(sound.active));
  group.add(notify);
  group.add(sound);
  return group;
}

const THEMES: readonly Theme[] = ['system', 'light', 'dark'];

/** Groupe « Apparence » : thème de l'application et du terminal intégré, appliqués en direct. */
function appearanceGroup(settings: Settings): Adw.PreferencesGroup {
  const group = new Adw.PreferencesGroup({ title: 'Apparence' });
  const d = settings.data.peek();
  const row = (key: 'appTheme' | 'terminalTheme', title: string, subtitle: string, system: string): Adw.ComboRow => {
    const r = comboRow(title, subtitle, false);
    setItems(r, [system, 'Jour', 'Nuit'], THEMES.indexOf(d[key]));
    r.connect('notify::selected', () => settings.setTheme(key, THEMES[r.selected] ?? 'system'));
    group.add(r);
    return r;
  };
  row('appTheme', 'Application', '', 'Système');
  const term = row('terminalTheme', 'Terminal intégré', '', 'Comme l’application');
  term.visible = integratedAvailable();
  return group;
}

const PREVIEW = `## Exemple de réponse

Voici un paragraphe avec du **gras**, de l'*italique*, du \`code en ligne\` et un [lien](https://opencode.ai). La seconde phrase s'étend sur plusieurs lignes pour montrer l'interligne quand le texte passe à la ligne.

### Étapes
- Lire le fichier \`src/app/Markdown.tsx\`
- Ajuster l'espacement
  - et les couleurs

> Une citation, pour voir son style.

\`\`\`ts
const style = { font: 'mono', spacing: 8 };
\`\`\``;

const FONTS = [
  ['system', 'Police de l’interface'],
  ['mono', 'Chasse fixe'],
  ['serif', 'Serif'],
] as const;
const COLORS = [
  ['sober', 'Sobres'],
  ['headings', 'Titres colorés'],
  ['colorful', 'Colorées (titres, puces, code, citations)'],
] as const;

/** Page « Rendu des messages » : police, interligne, espacement, couleurs, avec aperçu en direct. */
function markdownPage(settings: Settings): Adw.PreferencesPage {
  const page = new Adw.PreferencesPage({ title: 'Rendu des messages', iconName: 'format-text-rich-symbolic' });
  page.add(sizeGroup(settings));
  const group = new Adw.PreferencesGroup({ title: 'Mise en forme', description: 'Appliquée en direct à toutes les conversations.' });
  const d = settings.data.peek().markdown;

  const font = comboRow('Police', '', false);
  setItems(font, FONTS.map(([, l]) => l), FONTS.findIndex(([id]) => id === d.font));
  font.connect('notify::selected', () => settings.setMarkdownStyle({ font: FONTS[font.selected]?.[0] ?? 'system' }));

  const line = new Adw.SpinRow({
    title: 'Interligne',
    subtitle: 'Espace entre les lignes d’un paragraphe, en pixels',
    adjustment: new Gtk.Adjustment({ lower: 0, upper: 16, stepIncrement: 1, pageIncrement: 2, value: d.lineSpacing }),
  });
  line.connect('notify::value', () => settings.setMarkdownStyle({ lineSpacing: Math.round(line.value) }));

  const para = new Adw.SpinRow({
    title: 'Espace entre paragraphes',
    subtitle: 'En pixels ; titres, listes et code suivent proportionnellement',
    adjustment: new Gtk.Adjustment({ lower: 0, upper: 32, stepIncrement: 1, pageIncrement: 4, value: d.paragraphSpacing }),
  });
  para.connect('notify::value', () => settings.setMarkdownStyle({ paragraphSpacing: Math.round(para.value) }));

  const colors = comboRow('Couleurs', '', false);
  setItems(colors, COLORS.map(([, l]) => l), COLORS.findIndex(([id]) => id === d.colors));
  colors.connect('notify::selected', () => settings.setMarkdownStyle({ colors: COLORS[colors.selected]?.[0] ?? 'sober' }));

  const reset = new Gtk.Button({ label: 'Valeurs par défaut', halign: Gtk.Align.START, cssClasses: ['flat'] });
  reset.connect('clicked', () => {
    font.selected = 0;
    colors.selected = 0;
    line.value = DEFAULT_MARKDOWN_STYLE.lineSpacing;
    para.value = DEFAULT_MARKDOWN_STYLE.paragraphSpacing;
  });
  group.headerSuffix = reset;
  for (const r of [font, line, para, colors]) group.add(r);
  page.add(group);

  // aperçu : vrai rendu, reconstruit à chaque changement comme les conversations
  const previewGroup = new Adw.PreferencesGroup({ title: 'Aperçu' });
  const preview = createRoot((dispose) => {
    const w = MarkdownView({ text: PREVIEW });
    page.connect('destroy', dispose);
    return w;
  });
  const frame = new Gtk.Box({ cssClasses: ['card', 'conversation'], marginTop: 6 });
  preview.marginTop = 12;
  preview.marginBottom = 12;
  preview.marginStart = 16;
  preview.marginEnd = 16;
  preview.hexpand = true;
  frame.append(preview);
  previewGroup.add(frame);
  page.add(previewGroup);
  return page;
}

/** Groupe « IDE » : IDE par défaut des projets (chaque projet peut choisir le sien). */
function ideGroup(settings: Settings): Adw.PreferencesGroup {
  const group = new Adw.PreferencesGroup({ title: 'IDE', description: 'Bouton « ouvrir dans l’IDE » des projets et sessions ; chaque projet peut choisir le sien (menu du bouton).' });
  const ides = installedIdes();
  const row = comboRow('IDE par défaut', '', false);
  const ids = ['', ...ides.map((i) => i.id)];
  setItems(row, [ides.length === 0 ? 'Aucun IDE détecté' : `Automatique (${automaticIde(ides)?.name ?? ''})`, ...ides.map((i) => i.name)], ids.indexOf(settings.data.peek().defaultIde ?? ''));
  row.sensitive = ides.length > 0;
  row.connect('notify::selected', () => {
    const id = ids[row.selected] ?? '';
    settings.setOptional('defaultIde', id === '' ? undefined : id);
  });
  group.add(row);
  return group;
}

export function openPreferences(parent: Gtk.Widget, settings: Settings, providers: Promise<Providers>): void {
  const page = new Adw.PreferencesPage({ title: 'Général', iconName: 'preferences-system-symbolic' });
  page.add(appearanceGroup(settings));
  page.add(conversationGroup(settings));
  page.add(terminalGroup(settings));
  page.add(ideGroup(settings));
  page.add(modelGroup(settings, providers));
  const dialog = new Adw.PreferencesDialog({ title: 'Préférences', searchEnabled: false });
  dialog.add(page);
  dialog.add(markdownPage(settings));
  dialog.present(parent);
}
