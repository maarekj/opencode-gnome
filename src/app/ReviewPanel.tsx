// Revue commentée dans la fenêtre git : commentaires sur des lignes de diff (brouillon conservé
// par dépôt), panneau latéral pour les relire, les modifier, et les envoyer à une session.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createState, type Accessor } from 'gnim';
import { errorMessage } from '../shared/errors.ts';
import { esc } from '../shared/format.ts';
import { loadReview, newCommentId, reviewPrompt, saveReview, type ReviewComment, type ReviewOrigin } from '../shared/review.ts';
import type { DiffSelection } from '../shared/diff.ts';

/** Sessions où envoyer la revue (fournies par la page qui ouvre la fenêtre git). */
export interface ReviewTarget {
  readonly sessions: () => readonly { readonly id: string; readonly title: string }[];
  /** session présélectionnée (celle d'où la fenêtre a été ouverte) */
  readonly preferred: () => string | null;
  readonly send: (sessionID: string, text: string) => Promise<void>;
  /** après envoi : affiche la session */
  readonly open?: (sessionID: string) => void;
}

export class ReviewController {
  readonly comments: Accessor<readonly ReviewComment[]>;
  /** commentaire général (en plus des commentaires de lignes) */
  readonly global: Accessor<string>;
  readonly #set: (v: readonly ReviewComment[]) => void;
  readonly #setGlobal: (v: string) => void;
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
    const draft = loadReview(directory);
    [this.comments, this.#set] = createState<readonly ReviewComment[]>(draft.comments);
    [this.global, this.#setGlobal] = createState(draft.global);
  }

  #save(next: readonly ReviewComment[]): void {
    this.#set(next);
    saveReview(this.#directory, { comments: next, global: this.global.peek() });
  }

  setGlobal(text: string): void {
    this.#setGlobal(text);
    saveReview(this.#directory, { comments: this.comments.peek(), global: text });
  }

  /** Revue non vide (commentaires ou commentaire général). */
  get empty(): boolean {
    return this.comments.peek().length === 0 && this.global.peek().trim() === '';
  }

  prompt(): string {
    return reviewPrompt(this.comments.peek(), this.global.peek());
  }

  add(sel: DiffSelection, source: string, origin: ReviewOrigin, text: string): void {
    this.#save([...this.comments.peek(), { id: newCommentId(), file: sel.file, lines: sel.lines, source, origin, end: sel.end, excerpt: sel.excerpt, text, created: Date.now() }]);
  }

  update(id: string, text: string): void {
    this.#save(this.comments.peek().map((c) => (c.id === id ? Object.assign({}, c, { text }) : c)));
  }

  remove(id: string): void {
    this.#save(this.comments.peek().filter((c) => c.id !== id));
  }

  clear(): void {
    this.#setGlobal('');
    this.#save([]);
  }
}

/** Extrait de diff en police à chasse fixe, lignes ajoutées / retirées colorées. */
function excerptLabel(excerpt: string): Gtk.Label {
  const markup = excerpt
    .split('\n')
    .slice(0, 12)
    .map((l) => (l.startsWith('+') ? `<span foreground="#26a269">${esc(l)}</span>` : l.startsWith('-') ? `<span foreground="#c01c28">${esc(l)}</span>` : esc(l)))
    .join('\n');
  const more = excerpt.split('\n').length > 12 ? '\n…' : '';
  const label = new Gtk.Label({ xalign: 0, wrap: true, wrapMode: Pango.WrapMode.CHAR, selectable: true, cssClasses: ['monospace', 'caption', 'review-excerpt'] });
  label.set_markup(markup + more);
  return label;
}

/** Saisie du texte d'un commentaire (nouveau ou modification). */
export function askComment(parent: Gtk.Widget, heading: string, excerpt: string, initial: string, done: (text: string) => void): void {
  const view = new Gtk.TextView({ wrapMode: Gtk.WrapMode.WORD_CHAR, topMargin: 8, bottomMargin: 8, leftMargin: 10, rightMargin: 10, acceptsTab: false });
  view.buffer.text = initial;
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 });
  box.append(new Gtk.ScrolledWindow({ child: excerptLabel(excerpt), maxContentHeight: 160, propagateNaturalHeight: true, cssClasses: ['card'] }));
  box.append(new Gtk.ScrolledWindow({ child: view, minContentHeight: 100, maxContentHeight: 240, propagateNaturalHeight: true, cssClasses: ['card'] }));
  const dialog = new Adw.AlertDialog({ heading, extraChild: box, defaultResponse: 'save', closeResponse: 'cancel' });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('save', 'Enregistrer');
  dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
  const update = (): void => dialog.set_response_enabled('save', view.buffer.text.trim() !== '');
  view.buffer.connect('changed', update);
  update();
  dialog.connect('response', (_d: Adw.AlertDialog, r: string) => {
    const text = view.buffer.text.trim();
    if (r === 'save' && text !== '') done(text);
  });
  dialog.present(parent);
  view.grab_focus();
}

/** Panneau latéral « Revue » : commentaires, session cible, envoi. */
export function reviewPanel(review: ReviewController, target: ReviewTarget | undefined, toast: (m: string) => void, goto: (c: ReviewComment) => void): Gtk.Widget {
  const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, marginStart: 12, marginEnd: 12, marginTop: 12, marginBottom: 12 });
  const empty = new Adw.StatusPage({
    iconName: 'chat-message-new-symbolic',
    title: 'Aucun commentaire',
    description: 'Sélectionne des lignes d’un diff, puis « Commenter la sélection » (bouton ou clic droit).',
    cssClasses: ['compact'],
    vexpand: true,
  });
  const stack = new Gtk.Stack({ vexpand: true });
  stack.add_named(empty, 'empty');
  stack.add_named(new Gtk.ScrolledWindow({ child: list, hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true }), 'list');

  const sessionRow = new Adw.ComboRow({ title: 'Session', useSubtitle: false });
  let sessionIds: string[] = [];
  const refreshSessions = (): void => {
    const sessions = target?.sessions() ?? [];
    const keep = sessionIds[sessionRow.selected] ?? target?.preferred() ?? null;
    sessionIds = sessions.map((s) => s.id);
    sessionRow.model = Gtk.StringList.new(sessions.map((s) => (s.title === '' ? s.id : s.title)));
    sessionRow.selected = Math.max(0, sessionIds.indexOf(keep ?? ''));
  };
  // commentaire général : enregistré à chaque frappe
  const globalView = new Gtk.TextView({ wrapMode: Gtk.WrapMode.WORD_CHAR, topMargin: 8, bottomMargin: 8, leftMargin: 10, rightMargin: 10, acceptsTab: false, cssClasses: ['review-global'] });
  globalView.buffer.text = review.global.peek();
  globalView.buffer.connect('changed', () => review.setGlobal(globalView.buffer.text));
  const globalBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, marginStart: 12, marginEnd: 12, marginTop: 10 });
  globalBox.append(new Gtk.Label({ label: 'Commentaire général', xalign: 0, cssClasses: ['caption-heading'] }));
  globalBox.append(new Gtk.ScrolledWindow({ child: globalView, minContentHeight: 60, maxContentHeight: 160, propagateNaturalHeight: true, hscrollbarPolicy: Gtk.PolicyType.NEVER, cssClasses: ['card'] }));
  const send = new Gtk.Button({ label: 'Envoyer à l’agent', cssClasses: ['suggested-action', 'pill'], hexpand: true });
  const copyBtn = new Gtk.Button({ iconName: 'edit-copy-symbolic', tooltipText: 'Copier la revue (markdown)', cssClasses: ['circular'], valign: Gtk.Align.CENTER });
  copyBtn.connect('clicked', () => {
    copyBtn.get_clipboard().set(review.prompt());
    toast('Revue copiée');
  });
  const clear = new Gtk.Button({ label: 'Tout effacer', cssClasses: ['flat'], halign: Gtk.Align.CENTER });
  const sessionGroup = new Adw.PreferencesGroup({ marginStart: 12, marginEnd: 12 });
  sessionGroup.add(sessionRow);
  const footer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, marginBottom: 12 });
  footer.append(sessionGroup);
  const buttons = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, marginStart: 12, marginEnd: 12 });
  const sendRow = new Gtk.Box({ spacing: 6 });
  sendRow.append(send);
  sendRow.append(copyBtn);
  buttons.append(sendRow);
  buttons.append(clear);
  footer.append(buttons);
  if (target === undefined) {
    sessionGroup.visible = false;
    send.sensitive = false;
    send.tooltipText = 'Ouvre la fenêtre git depuis un projet ou une session pour envoyer la revue';
  }

  const title = new Gtk.Label({ label: 'Revue', xalign: 0, hexpand: true, cssClasses: ['heading'] });
  const header = new Gtk.Box({ spacing: 6, marginStart: 12, marginEnd: 12, marginTop: 10, marginBottom: 6 });
  header.append(title);

  const render = (): void => {
    const comments = review.comments.peek();
    title.label = comments.length === 0 ? 'Revue' : `Revue · ${comments.length} commentaire${comments.length > 1 ? 's' : ''}`;
    for (let c = list.get_first_child(); c !== null; c = list.get_first_child()) list.remove(c);
    for (const c of comments) {
      const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, cssClasses: ['card', 'review-comment'] });
      const top = new Gtk.Box({ spacing: 4 });
      const where = new Gtk.Label({ xalign: 0, hexpand: true, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, useMarkup: true, cssClasses: ['caption'], tooltipText: c.source });
      where.set_markup(`<b>${esc(c.file)}</b>  <span alpha="65%">${esc(c.lines)}</span>`);
      const edit = new Gtk.Button({ iconName: 'document-edit-symbolic', tooltipText: 'Modifier le commentaire', cssClasses: ['flat', 'circular'], valign: Gtk.Align.START });
      edit.connect('clicked', () => askComment(edit, `${c.file} — ${c.lines}`, c.excerpt, c.text, (t) => review.update(c.id, t)));
      const del = new Gtk.Button({ iconName: 'user-trash-symbolic', tooltipText: 'Supprimer le commentaire', cssClasses: ['flat', 'circular'], valign: Gtk.Align.START });
      del.connect('clicked', () => review.remove(c.id));
      top.append(where);
      top.append(edit);
      top.append(del);
      card.append(top);
      card.append(excerptLabel(c.excerpt));
      card.append(new Gtk.Label({ label: c.text, xalign: 0, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR }));
      // clic : le fichier et la ligne dans le diff
      if (c.origin !== undefined) {
        const click = new Gtk.GestureClick();
        click.connect('released', () => goto(c));
        card.add_controller(click);
        card.set_cursor_from_name('pointer');
        card.tooltipText = 'Afficher dans le diff';
      }
      list.append(card);
    }
    stack.visibleChildName = comments.length === 0 ? 'empty' : 'list';
    updateButtons();
  };
  const updateButtons = (): void => {
    send.sensitive = target !== undefined && !review.empty;
    copyBtn.sensitive = !review.empty;
    clear.sensitive = !review.empty;
  };
  review.comments.subscribe(render);
  review.global.subscribe(updateButtons);
  render();
  refreshSessions();

  clear.connect('clicked', () => {
    const dialog = new Adw.AlertDialog({ heading: 'Effacer la revue ?', body: 'Tous les commentaires du brouillon seront supprimés.', defaultResponse: 'cancel', closeResponse: 'cancel' });
    dialog.add_response('cancel', 'Annuler');
    dialog.add_response('clear', 'Effacer');
    dialog.set_response_appearance('clear', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.connect('response', (_d: Adw.AlertDialog, r: string) => {
      if (r !== 'clear') return;
      review.clear();
      globalView.buffer.text = '';
    });
    dialog.present(clear);
  });
  send.connect('clicked', () => {
    const id = sessionIds[sessionRow.selected];
    if (target === undefined || id === undefined) return;
    send.sensitive = false;
    target
      .send(id, review.prompt())
      .then(() => {
        // revue conservée : utile pour vérifier ensuite ce que l'agent a fait
        send.sensitive = true;
        toast('Revue envoyée à l’agent');
        target.open?.(id);
        return null;
      })
      .catch((e: unknown) => {
        send.sensitive = true;
        toast(`Envoi impossible : ${errorMessage(e)}`);
      });
  });

  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, widthRequest: 340, cssClasses: ['review-panel'] });
  box.append(header);
  box.append(new Gtk.Separator());
  box.append(globalBox);
  box.append(stack);
  box.append(new Gtk.Separator());
  box.append(footer);
  // sessions relues à chaque affichage du panneau (nouvelles sessions)
  box.connect('map', refreshSessions);
  return box;
}
