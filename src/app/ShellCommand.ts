// Commande de l'outil bash, dépliée (#143) : une ligne par étape (&&, ||, ;, | en retrait),
// mots mis en forme, arguments longs repliés (lien « … » pour les déplier), commande brute à la
// demande et bouton de copie.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { esc } from '../shared/format.ts';
import { abbreviate, isLong, parseShell, type Step, type Word, type WordKind } from '../shared/shell.ts';

const hex = (v: number): string => Math.round(v * 255).toString(16).padStart(2, '0');

function accent(): string {
  try {
    // Pango n'accepte que #rrggbb (pas rgb(…) de Gdk.RGBA.to_string)
    const c = Adw.StyleManager.get_default().get_accent_color_rgba();
    return `#${hex(c.red)}${hex(c.green)}${hex(c.blue)}`;
  } catch {
    return '#3584e4';
  }
}

/** Mise en forme Pango de chaque sorte de mot (texte déjà échappé). */
const STYLE: Readonly<Record<WordKind, (t: string, color: string) => string>> = {
  command: (t) => `<b>${t}</b>`,
  option: (t, color) => `<span foreground="${color}">${t}</span>`,
  string: (t) => `<i>${t}</i>`,
  heredoc: (t) => `<i>${t}</i>`,
  redirect: (t) => `<span alpha="60%">${t}</span>`,
  comment: (t) => `<span alpha="60%">${t}</span>`,
  assign: (t) => `<span alpha="80%">${t}</span>`,
  group: (t) => t,
  word: (t) => t,
};

const wordMarkup = (w: Word, text: string, color: string): string => STYLE[w.kind](esc(text), color);

/** Ligne d'une étape : mots longs repliés en lien « … », dépliés par un clic (et repliables). */
function stepLabel(step: Step, color: string): Gtk.Label {
  const open = new Set<number>();
  // pas de retour à la ligne automatique : seuls ceux de la commande comptent (défilement horizontal)
  const label = new Gtk.Label({ xalign: 0, hexpand: true, selectable: true, cssClasses: ['monospace', 'shell-step'] });
  const render = (): void => {
    const parts = step.words.map((w, i) => {
      if (!isLong(w)) return wordMarkup(w, w.text, color);
      if (open.has(i)) return `${w.kind === 'heredoc' ? '\n' : ''}${wordMarkup(w, w.text, color)} <a href="fold:${i}" title="Replier">⟨replier⟩</a>`;
      const lines = w.text.split('\n').length;
      const more = lines > 1 ? ` <span alpha="60%">(${lines} lignes)</span>` : '';
      return `<a href="unfold:${i}" title="Afficher l'argument complet">${esc(abbreviate(w))}</a>${more}`;
    });
    label.set_markup(parts.join(' ').replaceAll(' \n', '\n'));
  };
  label.connect('activate-link', (_l: Gtk.Label, uri: string) => {
    const m = /^(un)?fold:(\d+)$/u.exec(uri);
    if (m === null) return false;
    const i = Number(m[2]);
    if (m[1] === undefined) open.delete(i);
    else open.add(i);
    render();
    return true;
  });
  render();
  return label;
}

/** espace sous le texte pour la barre de défilement horizontale (élargie au survol) */
const SCROLLBAR_SPACE = 24;

/**
 * Défilement horizontal d'un texte sans retour à la ligne automatique (commande, sortie) : la
 * hauteur suit le contenu ; s'il déborde, un espace est réservé dessous pour la barre de
 * défilement, qui ne recouvre plus la dernière ligne (#151) ; aucun espace sinon.
 */
export function horizontalScroller(child: Gtk.Widget): Gtk.ScrolledWindow {
  const scroller = new Gtk.ScrolledWindow({ child, hscrollbarPolicy: Gtk.PolicyType.AUTOMATIC, vscrollbarPolicy: Gtk.PolicyType.NEVER, propagateNaturalHeight: true, hexpand: true });
  const adj = scroller.get_hadjustment();
  let queued = false;
  const reserve = (): void => {
    if (queued) return;
    queued = true;
    // différé : changer une marge pendant l'allocation la fausse
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      queued = false;
      const margin = adj.upper > adj.pageSize + 1 ? SCROLLBAR_SPACE : 0;
      if (child.marginBottom !== margin) child.marginBottom = margin;
      return GLib.SOURCE_REMOVE;
    });
  };
  adj.connect('changed', reserve);
  adj.connect('notify::upper', reserve);
  adj.connect('notify::page-size', reserve);
  return scroller;
}

const OP_LABEL: Readonly<Record<string, string>> = { '': '', '&&': '&&', '||': '||', ';': ';', '|': '|', '|&': '|&', '&': '&' };

/**
 * Vue structurée d'une commande ; null pour une commande simple (une étape sans argument long)
 * ou mal formée : affichage brut.
 */
export function ShellCommand(command: string): Gtk.Widget | null {
  let steps: Step[];
  try {
    steps = parseShell(command);
  } catch {
    return null;
  }
  if (steps.length === 0 || (steps.length === 1 && !(steps[0]?.words ?? []).some((w) => isLong(w)))) return null;
  const color = accent();
  const structured = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
  for (const step of steps) {
    const piped = step.op === '|' || step.op === '|&';
    const row = new Gtk.Box({ spacing: 8, marginStart: piped ? 18 : 0 });
    row.append(new Gtk.Label({ label: OP_LABEL[step.op] ?? step.op, widthChars: 2, xalign: 1, valign: Gtk.Align.START, cssClasses: ['monospace', 'dim-label', 'shell-op'] }));
    row.append(stepLabel(step, color));
    structured.append(row);
  }
  const raw = new Gtk.Label({ label: `$ ${command}`, xalign: 0, hexpand: true, selectable: true, wrap: true, wrapMode: Pango.WrapMode.CHAR, cssClasses: ['monospace'] });
  const stack = new Gtk.Stack({ hhomogeneous: false, vhomogeneous: false, interpolateSize: true });
  // lignes longues : défilement horizontal, la hauteur suit le contenu (pas de défilement vertical)
  const scroller = horizontalScroller(structured);
  stack.add_named(scroller, 'structured');
  stack.add_named(raw, 'raw');
  const toggle = new Gtk.ToggleButton({ iconName: 'utilities-terminal-symbolic', tooltipText: 'Commande brute', valign: Gtk.Align.START, cssClasses: ['flat', 'circular', 'shell-raw'] });
  toggle.connect('toggled', () => {
    stack.visibleChildName = toggle.active ? 'raw' : 'structured';
  });
  const copy = new Gtk.Button({ iconName: 'edit-copy-symbolic', tooltipText: 'Copier la commande', valign: Gtk.Align.START, cssClasses: ['flat', 'circular'] });
  copy.connect('clicked', () => {
    copy.get_clipboard().set_content(Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', new GLib.Bytes(new TextEncoder().encode(command))));
  });
  const box = new Gtk.Box({ spacing: 4, cssClasses: ['tool-output', 'shell-command'] });
  box.append(stack);
  box.append(toggle);
  box.append(copy);
  return box;
}
