// Demandes en attente d'une réponse, affichées dans le flux de la conversation :
// permissions (autoriser / toujours / refuser) et questions ; plus le rappel replié
// d'une question déjà répondue.
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { esc } from '../shared/format.ts';
import type { Part, PermissionRequest, QuestionInfo, QuestionRequest } from '../shared/schemas.ts';

/** Réponses : résolues à false en cas d'échec (erreur déjà affichée). */
export interface RequestActions {
  replyPermission: (id: string, reply: 'once' | 'always' | 'reject') => Promise<boolean>;
  replyQuestion: (id: string, answers: string[][]) => Promise<boolean>;
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

export function PermissionCard({ request, actions }: { request: PermissionRequest; actions: RequestActions }): JSX.Element {
  const detail = field(request.metadata, 'command') ?? field(request.metadata, 'filepath') ?? (request.patterns ?? []).join('\n');
  let card: Gtk.Widget | null = null;
  const reply = (r: 'once' | 'always' | 'reject'): void => answerOnce(() => card, () => actions.replyPermission(request.id, r));
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
        <Gtk.Label useMarkup label={`Autoriser <b>${esc(request.permission)}</b> ?`} xalign={0} hexpand />
      </Gtk.Box>
      {detail === '' ? null : <Gtk.Label label={detail} xalign={0} wrap wrapMode={Pango.WrapMode.CHAR} selectable cssClasses={['monospace', 'tool-output']} />}
      <Gtk.Box spacing={6} halign={Gtk.Align.END}>
        <Gtk.Button label="Refuser" onClicked={() => reply('reject')} />
        <Gtk.Button
          label="Toujours"
          tooltipText={`Autoriser pour la session : ${(request.always ?? []).join(', ')}`}
          onClicked={() => reply('always')}
        />
        <Gtk.Button label="Autoriser" cssClasses={['suggested-action']} onClicked={() => reply('once')} />
      </Gtk.Box>
    </Gtk.Box>
  );
}

/** Une question : choix exclusifs (radio) ou multiples (cases), plus « Autre réponse » si autorisée. */
function QuestionBlock({ info, answer }: { info: QuestionInfo; answer: { get: () => string[] } }): JSX.Element {
  const checks: Gtk.CheckButton[] = [];
  const entry = info.custom === false ? null : new Gtk.Entry({ placeholderText: 'Ta réponse…', visible: false });
  answer.get = () => {
    const picked = checks.filter((c) => c.active).map((c) => c.label ?? '');
    const custom = entry?.visible === true ? entry.text.trim() : '';
    return custom === '' ? picked : [...picked, custom];
  };
  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
      <Gtk.Label label={info.question} xalign={0} wrap cssClasses={['heading']} />
      {info.options.map((o) => {
        const check = new Gtk.CheckButton({ label: o.label });
        if (info.multiple !== true && checks[0] !== undefined) check.set_group(checks[0]);
        checks.push(check);
        return (
          <Gtk.Box orientation={Gtk.Orientation.VERTICAL}>
            {check}
            {o.description === undefined || o.description === '' ? null : (
              <Gtk.Label label={o.description} xalign={0} wrap marginStart={28} cssClasses={['dim-label', 'caption']} />
            )}
          </Gtk.Box>
        );
      })}
      {entry === null ? null : (
        <Gtk.Button
          label="Autre réponse…"
          halign={Gtk.Align.START}
          cssClasses={['flat', 'other-answer']}
          onClicked={(self: Gtk.Button) => {
            self.visible = false;
            entry.visible = true;
            entry.grab_focus();
          }}
        />
      )}
      {entry}
    </Gtk.Box>
  );
}

export function QuestionCard({ request, actions }: { request: QuestionRequest; actions: RequestActions }): JSX.Element {
  const answers = request.questions.map(() => ({ get: (): string[] => [] }));
  let card: Gtk.Widget | null = null;
  return (
    <Gtk.Box
      orientation={Gtk.Orientation.VERTICAL}
      spacing={14}
      cssClasses={['card', 'request', 'question']}
      $={(self: Gtk.Box) => {
        card = self;
      }}
    >
      {request.questions.map((q, i) => (
        <QuestionBlock info={q} answer={answers[i] ?? { get: () => [] }} />
      ))}
      <Gtk.Box spacing={6} halign={Gtk.Align.END}>
        <Gtk.Button label="Ignorer" onClicked={() => answerOnce(() => card, () => actions.rejectQuestion(request.id))} />
        <Gtk.Button
          label="Répondre"
          cssClasses={['suggested-action']}
          onClicked={() => answerOnce(() => card, () => actions.replyQuestion(request.id, answers.map((a) => a.get())))}
        />
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
export function AnsweredQuestions({ part }: { part: Part }): JSX.Element {
  const questions = questionsOf(part.state?.input);
  const answers = answersOf(part.state?.metadata);
  const rejected = part.state?.status === 'error';
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
