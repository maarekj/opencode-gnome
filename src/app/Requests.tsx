// Demandes en attente d'une réponse, affichées dans le flux de la conversation : permissions
// (autoriser / toujours / refuser) et formulaires (questions de l'agent, champs typés d'OpenCode
// 2) ; plus le rappel replié d'une question déjà répondue.
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { esc } from '../shared/format.ts';
import type { ToolCall } from '../shared/conversation.ts';
import type { FormAnswer, FormField, FormV2, PermissionV2 } from '../shared/v2/schemas.ts';
import { openUri } from './OpenFolder.ts';
import { ShellCommand } from './ShellCommand.ts';

/** Réponses : résolues à false en cas d'échec (erreur déjà affichée). */
export interface RequestActions {
  replyPermission: (id: string, reply: 'once' | 'always' | 'reject') => Promise<boolean>;
  replyQuestion: (id: string, answer: FormAnswer) => Promise<boolean>;
  rejectQuestion: (id: string) => Promise<boolean>;
}

/**
 * Carte désactivée dès la première réponse (pas de double envoi), réactivée si l'envoi échoue ;
 * en cas de succès, la carte disparaît avec la demande (#85).
 */
function answerOnce(card: () => Gtk.Widget | null, send: () => Promise<boolean>): void {
  const widget = card();
  if (widget === null || !widget.sensitive) return;
  widget.sensitive = false;
  void send().then((ok) => {
    if (!ok) widget.sensitive = true;
    return ok;
  });
}

const field = (v: unknown, key: string): string | undefined => {
  if (typeof v !== 'object' || v === null || !(key in v)) return undefined;
  const value: unknown = Reflect.get(v, key);
  return typeof value === 'string' ? value : undefined;
};

/** Action v2 → libellé : `shell` (v1 : `bash`), `edit`, `read`… */
const SHELL = new Set(['shell', 'bash']);

export function PermissionCard({ request, actions, command: callCommand }: { request: PermissionV2; actions: RequestActions; command?: string | undefined }): JSX.Element {
  // commande : celle de l'appel d'outil (complète), sinon les ressources demandées
  const command = callCommand ?? field(request.metadata, 'command');
  const detail = command ?? request.resources.join('\n');
  // commande shell : même vue structurée que l'outil shell déplié (#143)
  const shell = SHELL.has(request.action) && detail !== '' ? ShellCommand(detail) : null;
  let card: Gtk.Widget | null = null;
  const reply = (r: 'once' | 'always' | 'reject'): void => answerOnce(() => card, () => actions.replyPermission(request.id, r));
  const always = request.save ?? request.resources;
  return (
    <Gtk.Box
      orientation={Gtk.Orientation.VERTICAL}
      spacing={8}
      cssClasses={['card', 'request', 'permission']}
      $={(self: Gtk.Box) => {
        card = self;
      }}
    >
      <Gtk.Box spacing={8}>
        <Gtk.Image iconName="dialog-warning-symbolic" cssClasses={['warning']} />
        <Gtk.Label useMarkup label={`Autoriser <b>${esc(request.action)}</b> ?`} xalign={0} hexpand />
      </Gtk.Box>
      {request.message === undefined || request.message === '' ? null : <Gtk.Label label={request.message} xalign={0} wrap cssClasses={['dim-label']} />}
      {shell ?? (detail === '' ? null : <Gtk.Label label={detail} xalign={0} wrap wrapMode={Pango.WrapMode.CHAR} selectable cssClasses={['monospace', 'tool-output']} />)}
      <Gtk.Box spacing={6} halign={Gtk.Align.END}>
        <Gtk.Button label="Refuser" onClicked={() => reply('reject')} />
        <Gtk.Button label="Toujours" tooltipText={`Autoriser désormais : ${always.join(', ')}`} onClicked={() => reply('always')} />
        <Gtk.Button label="Autoriser" cssClasses={['suggested-action']} onClicked={() => reply('once')} />
      </Gtk.Box>
    </Gtk.Box>
  );
}

/** Un champ de formulaire : sa valeur (undefined : sans réponse) et son widget. */
interface FieldInput {
  readonly key: string;
  readonly widget: Gtk.Widget;
  readonly value: () => string | number | boolean | string[] | null | undefined;
  /** notifie un changement (conditions d'affichage `when` des autres champs) */
  readonly onChange: (fn: () => void) => void;
}

/** Choix parmi des options (radio, ou cases si `multiple`), plus « Autre réponse » si `custom`. */
function choiceInput(key: string, options: readonly { value: string; label: string; description?: string | undefined }[], multiple: boolean, custom: boolean, initial: readonly string[]): FieldInput {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
  const checks: { check: Gtk.CheckButton; value: string }[] = [];
  const listeners: (() => void)[] = [];
  const changed = (): void => {
    for (const fn of listeners) fn();
  };
  for (const o of options) {
    const check = new Gtk.CheckButton({ label: o.label, active: initial.includes(o.value) });
    const first = checks[0];
    if (!multiple && first !== undefined) check.set_group(first.check);
    check.connect('toggled', changed);
    checks.push({ check, value: o.value });
    box.append(check);
    if (o.description !== undefined && o.description.trim() !== '') box.append(new Gtk.Label({ label: o.description.trim(), xalign: 0, wrap: true, marginStart: 28, cssClasses: ['dim-label', 'caption'] }));
  }
  const entry = custom ? new Gtk.Entry({ placeholderText: 'Ta réponse…', visible: options.length === 0 }) : null;
  if (entry !== null) {
    entry.connect('changed', changed);
    if (options.length > 0) {
      const other = new Gtk.Button({ label: 'Autre réponse…', halign: Gtk.Align.START, cssClasses: ['flat', 'other-answer'] });
      other.connect('clicked', () => {
        other.visible = false;
        entry.visible = true;
        entry.grab_focus();
      });
      box.append(other);
    }
    box.append(entry);
  }
  const picked = (): string[] => {
    const out = checks.filter((c) => c.check.active).map((c) => c.value);
    const text = entry?.visible === true ? entry.text.trim() : '';
    return text === '' ? out : multiple ? [...out, text] : [text];
  };
  return {
    key,
    widget: box,
    value: () => {
      const p = picked();
      if (multiple) return p;
      return p[0];
    },
    onChange: (fn) => {
      listeners.push(fn);
    },
  };
}

/** Nombre fini (les bornes JSON peuvent valoir « Infinity »…). */
const num = (v: number | string | undefined): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function fieldInput(f: FormField): FieldInput {
  if (f.type === 'external') {
    // lien externe (connexion, page à ouvrir) : pas de valeur
    const button = new Gtk.Button({ label: f.title ?? 'Ouvrir le lien', halign: Gtk.Align.START, cssClasses: ['pill'], tooltipText: f.url });
    button.connect('clicked', () => {
      openUri(button, f.url);
    });
    return { key: f.key, widget: button, value: () => null, onChange: () => {} };
  }
  if (f.type === 'string') {
    if (f.options !== undefined && f.options.length > 0) return choiceInput(f.key, f.options, false, f.custom !== false, f.default === undefined ? [] : [f.default]);
    const entry = new Gtk.Entry({ placeholderText: f.placeholder ?? '', text: f.default ?? '' });
    const value = (): string | undefined => (entry.text.trim() === '' ? undefined : entry.text);
    return { key: f.key, widget: entry, value, onChange: (fn) => void entry.connect('changed', fn) };
  }
  if (f.type === 'multiselect') return choiceInput(f.key, f.options, true, f.custom === true, f.default ?? []);
  if (f.type === 'boolean') {
    // infobulle : nom accessible de l'interrupteur (sans libellé propre)
    const sw = new Gtk.Switch({ active: f.default === true, halign: Gtk.Align.START, tooltipText: f.description ?? f.title ?? '' });
    return { key: f.key, widget: sw, value: () => sw.active, onChange: (fn) => void sw.connect('notify::active', fn) };
  }
  // nombre ou entier
  const spin = Gtk.SpinButton.new_with_range(num(f.minimum) ?? -1e9, num(f.maximum) ?? 1e9, 1);
  spin.digits = f.type === 'integer' ? 0 : 2;
  spin.value = num(f.default) ?? Math.max(0, num(f.minimum) ?? 0);
  spin.halign = Gtk.Align.START;
  const value = (): number => (f.type === 'integer' ? Math.round(spin.value) : spin.value);
  return { key: f.key, widget: spin, value, onChange: (fn) => void spin.connect('value-changed', fn) };
}

/** Champ visible selon ses conditions `when` (valeurs des autres champs). */
function shown(f: FormField, values: (key: string) => unknown): boolean {
  if (f.type === 'external') return true;
  if (f.hidden === true) return false;
  return (f.when ?? []).every((w) => {
    const v = values(w.key);
    const equal = Array.isArray(v) ? v.includes(String(w.value)) : v === w.value;
    return w.op === 'eq' ? equal : !equal;
  });
}

/** Formulaire (questions de l'agent) : un bloc par champ, « Répondre » / « Ignorer ». */
export function QuestionCard({ request, actions }: { request: FormV2; actions: RequestActions }): JSX.Element {
  let card: Gtk.Widget | null = null;
  const inputs: { field: FormField; input: FieldInput; row: Gtk.Box }[] = [];
  for (const f of request.fields) {
    const input = fieldInput(f);
    const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
    const title = f.title ?? '';
    const description = f.description ?? '';
    // question de l'agent : la question est la description, le titre un en-tête court
    if (description !== '') row.append(new Gtk.Label({ label: description, xalign: 0, wrap: true, cssClasses: ['heading'] }));
    else if (title !== '') row.append(new Gtk.Label({ label: title, xalign: 0, wrap: true, cssClasses: ['heading'] }));
    row.append(input.widget);
    inputs.push({ field: f, input, row });
  }
  const values = (key: string): unknown => inputs.find((i) => i.input.key === key)?.input.value();
  const update = (): void => {
    for (const i of inputs) i.row.visible = shown(i.field, values);
  };
  for (const i of inputs) i.input.onChange(update);
  update();
  const answer = (): FormAnswer => {
    const out: FormAnswer = {};
    for (const i of inputs) {
      if (!i.row.visible) continue;
      const v = i.input.value();
      if (v !== undefined && v !== null) out[i.input.key] = v;
    }
    return out;
  };
  return (
    <Gtk.Box
      orientation={Gtk.Orientation.VERTICAL}
      spacing={14}
      cssClasses={['card', 'request', 'question']}
      $={(self: Gtk.Box) => {
        card = self;
      }}
    >
      {request.title === '' || request.title === 'Questions' ? null : <Gtk.Label label={request.title} xalign={0} wrap cssClasses={['title-4']} />}
      {inputs.map((i) => i.row)}
      <Gtk.Box spacing={6} halign={Gtk.Align.END}>
        <Gtk.Button label="Ignorer" onClicked={() => answerOnce(() => card, () => actions.rejectQuestion(request.id))} />
        <Gtk.Button label="Répondre" cssClasses={['suggested-action']} onClicked={() => answerOnce(() => card, () => actions.replyQuestion(request.id, answer()))} />
      </Gtk.Box>
    </Gtk.Box>
  );
}

// ---------------------------------------------------------------- question répondue

const questionsOf = (input: unknown): string[] => {
  if (typeof input !== 'object' || input === null || !('questions' in input) || !Array.isArray(input.questions)) return [];
  return input.questions.map((q: unknown) => field(q, 'question') ?? '');
};

const answersOf = (metadata: unknown): string[][] => {
  if (typeof metadata !== 'object' || metadata === null || !('answers' in metadata) || !Array.isArray(metadata.answers)) return [];
  return metadata.answers.map((a: unknown) => (Array.isArray(a) ? a.filter((x: unknown): x is string => typeof x === 'string') : []));
};

/** Rappel replié d'un appel de l'outil `question` terminé : questions + réponses choisies. */
export function AnsweredQuestions({ tool }: { tool: ToolCall }): JSX.Element {
  const questions = questionsOf(tool.input);
  const answers = answersOf(tool.metadata);
  const rejected = tool.status === 'error';
  const title = rejected ? 'Questions ignorées' : questions.length > 1 ? `${questions.length} questions répondues` : 'Question répondue';
  return (
    <Gtk.Expander cssClasses={['answered']}>
      <Gtk.Box $type="label" spacing={8}>
        <Gtk.Image iconName="help-about-symbolic" cssClasses={['dim-label']} />
        <Gtk.Label label={title} cssClasses={['heading']} />
        <Gtk.Label
          label={questions[0] ?? ''}
          ellipsize={Pango.EllipsizeMode.END}
          xalign={0}
          hexpand
          cssClasses={['dim-label']}
        />
      </Gtk.Box>
      <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={10} marginTop={8} marginStart={28}>
        {questions.map((q, i) => (
          <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
            <Gtk.Label label={q} xalign={0} wrap selectable cssClasses={['heading']} />
            <Gtk.Label
              label={(answers[i] ?? []).length === 0 ? '(sans réponse)' : (answers[i] ?? []).join(' · ')}
              xalign={0}
              wrap
              selectable
              cssClasses={(answers[i] ?? []).length === 0 ? ['dim-label'] : ['accent']}
            />
          </Gtk.Box>
        ))}
      </Gtk.Box>
    </Gtk.Expander>
  );
}
