// Menu Aide : guide d'utilisation (F1), raccourcis clavier (Ctrl+?), à propos.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import { createRoot } from 'gnim';
import { errorMessage } from '../shared/errors.ts';
import { appVersion, readGuide, REPOSITORY } from '../shared/help.ts';
import type { Store } from '../shared/store.ts';
import { MarkdownView } from './Markdown.tsx';

let guide: Adw.Window | null = null;

/** Fenêtre « Guide d'utilisation » : docs/guide.md avec le rendu markdown de l'application. */
export function openGuide(app: Gtk.Application, root: string): void {
  if (guide !== null) {
    guide.present();
    return;
  }
  const win = new Adw.Window({ title: "Guide d'utilisation", defaultWidth: 760, defaultHeight: 820, application: app });
  guide = win;
  createRoot((dispose) => {
    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(new Adw.HeaderBar());
    const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, marginTop: 12, marginBottom: 24, marginStart: 24, marginEnd: 24, cssClasses: ['conversation'] });
    body.append(MarkdownView({ text: readGuide(root) }));
    const clamp = new Adw.Clamp({ maximumSize: 760, child: body });
    toolbar.content = new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true, child: clamp });
    win.content = toolbar;
    win.connect('close-request', () => {
      guide = null;
      dispose();
      return false;
    });
  });
  const keys = new Gtk.EventControllerKey();
  keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number) => {
    if (keyval !== Gdk.KEY_Escape) return false;
    win.close();
    return true;
  });
  win.add_controller(keys);
  win.present();
}

/** Raccourcis de l'application, par section (titre, accélérateur GTK). */
export const SHORTCUTS: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
  [
    'Général',
    [
      ["Guide d'utilisation", 'F1'],
      ['Raccourcis clavier', '<Control>question'],
      ['Préférences', '<Control>comma'],
      ['Rechercher un projet', '<Control>k'],
      ['Rechercher une session (page du projet)', '<Control>f'],
      ['Fermer la session affichée', '<Control>w'],
    ],
  ],
  [
    'Conversation',
    [
      ["Afficher / masquer les appels d'outils", '<Control><Shift>o'],
      ['Envoyer le prompt', '<Control>Return'],
      ['Niveau de raisonnement suivant', '<Control>t'],
      ['Prompt précédent / suivant (historique)', 'Up Down'],
      ['Coller une image ou des fichiers', '<Control>v'],
      ['Compléter une commande ou une mention', 'Tab'],
    ],
  ],
  [
    'Terminal intégré',
    [
      ['Afficher / masquer les terminaux', '<Control><Shift>j'],
      ['Copier', '<Control><Shift>c'],
      ['Coller', '<Control><Shift>v'],
      ['Agrandir / réduire le texte', '<Control>plus <Control>minus'],
      ['Taille normale', '<Control>0'],
    ],
  ],
  [
    'Fenêtres git et serveur',
    [
      ['Recharger', 'F5'],
      ['Fermer', 'Escape'],
    ],
  ],
];

/** Fenêtre « Raccourcis clavier » (Adw.ShortcutsDialog). */
export function openShortcuts(parent: Gtk.Widget): void {
  const dialog = new Adw.ShortcutsDialog();
  for (const [title, items] of SHORTCUTS) {
    const section = Adw.ShortcutsSection.new(title);
    for (const [label, accel] of items) section.add(Adw.ShortcutsItem.new(label, accel));
    dialog.add(section);
  }
  dialog.present(parent);
}

/** Fenêtre « À propos » : versions de l'application et du serveur opencode, dépôt. */
export function openAbout(parent: Gtk.Widget, root: string, store: Store, icon: string): void {
  const dialog = new Adw.AboutDialog({
    applicationName: 'opencode-gnome',
    applicationIcon: icon,
    developerName: 'Joseph Maarek',
    version: appVersion(root) ?? '—',
    website: REPOSITORY,
    issueUrl: `${REPOSITORY}/issues`,
    licenseType: Gtk.License.UNKNOWN,
    comments: 'Client GNOME pour opencode.\n\nopencode : chargement…',
  });
  // version du serveur opencode, affichée dans « Détails »
  void (async () => {
    try {
      dialog.comments = `Client GNOME pour opencode.\n\nopencode ${(await store.client.health()).version}`;
    } catch (e) {
      dialog.comments = `Client GNOME pour opencode.\n\nopencode : serveur injoignable (${errorMessage(e)})`;
    }
  })();
  dialog.present(parent);
}
