// Demandes en attente d'une réponse : permissions (autoriser / toujours / refuser) et questions.
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { For, type Accessor } from 'gnim';
import { esc } from '../shared/format.ts';
import type { PermissionRequest, QuestionInfo, QuestionRequest } from '../shared/schemas.ts';

export interface RequestsProps {
  permissions: Accessor<readonly PermissionRequest[]>;
  questions: Accessor<readonly QuestionRequest[]>;
  replyPermission: (id: string, reply: 'once' | 'always' | 'reject') => void;
  replyQuestion: (id: string, answers: string[][]) => void;
  rejectQuestion: (id: string) => void;
}

const field = (v: unknown, key: string): string | undefined => {
  if (typeof v !== 'object' || v === null || !(key in v)) return undefined;
  const value: unknown = Reflect.get(v, key);
  return typeof value === 'string' ? value : undefined;
};

function PermissionCard({ request, reply }: { request: PermissionRequest; reply: RequestsProps['replyPermission'] }): JSX.Element {
  const detail = field(request.metadata, 'command') ?? field(request.metadata, 'filepath') ?? (request.patterns ?? []).join('\n');
  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={8} cssClasses={['card', 'request', 'permission']}>
      <Gtk.Box spacing={8}>
        <Gtk.Image iconName="dialog-warning-symbolic" cssClasses={['warning']} />
        <Gtk.Label useMarkup label={`Autoriser <b>${esc(request.permission)}</b> ?`} xalign={0} hexpand />
      </Gtk.Box>
      {detail === '' ? null : <Gtk.Label label={detail} xalign={0} wrap wrapMode={Pango.WrapMode.CHAR} selectable cssClasses={['monospace', 'tool-output']} />}
      <Gtk.Box spacing={6} halign={Gtk.Align.END}>
        <Gtk.Button label="Refuser" onClicked={() => reply(request.id, 'reject')} />
        <Gtk.Button label="Toujours" tooltipText={`Autoriser pour la session : ${(request.always ?? []).join(', ')}`} onClicked={() => reply(request.id, 'always')} />
        <Gtk.Button label="Autoriser" cssClasses={['suggested-action']} onClicked={() => reply(request.id, 'once')} />
      </Gtk.Box>
    </Gtk.Box>
  );
}

/** Une question : choix exclusifs (radio) ou multiples (cases), plus saisie libre si autorisée. */
function QuestionBlock({ info, answer }: { info: QuestionInfo; answer: { get: () => string[] } }): JSX.Element {
  const checks: Gtk.CheckButton[] = [];
  const entry = info.custom === false ? null : new Gtk.Entry({ placeholderText: 'Autre réponse…' });
  answer.get = () => {
    const picked = checks.filter((c) => c.active).map((c) => c.label ?? '');
    const custom = entry?.text.trim() ?? '';
    return custom === '' ? picked : [...picked, custom];
  };
  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
      <Gtk.Label label={info.question} xalign={0} wrap cssClasses={['heading']} />
      {info.options.map((o) => {
        const check = new Gtk.CheckButton({ label: o.label, tooltipText: o.description ?? '' });
        if (info.multiple !== true && checks[0] !== undefined) check.set_group(checks[0]);
        checks.push(check);
        return (
          <Gtk.Box orientation={Gtk.Orientation.VERTICAL}>
            {check}
            {o.description === undefined || o.description === '' ? null : <Gtk.Label label={o.description} xalign={0} wrap marginStart={28} cssClasses={['dim-label', 'caption']} />}
          </Gtk.Box>
        );
      })}
      {entry}
    </Gtk.Box>
  );
}

function QuestionCard({ request, props }: { request: QuestionRequest; props: RequestsProps }): JSX.Element {
  const answers = request.questions.map(() => ({ get: (): string[] => [] }));
  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={10} cssClasses={['card', 'request']}>
      {request.questions.map((q, i) => (
        <QuestionBlock info={q} answer={answers[i] ?? { get: () => [] }} />
      ))}
      <Gtk.Box spacing={6} halign={Gtk.Align.END}>
        <Gtk.Button label="Ignorer" onClicked={() => props.rejectQuestion(request.id)} />
        <Gtk.Button label="Répondre" cssClasses={['suggested-action']} onClicked={() => props.replyQuestion(request.id, answers.map((a) => a.get()))} />
      </Gtk.Box>
    </Gtk.Box>
  );
}

export function Requests(props: RequestsProps): JSX.Element {
  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={8} marginStart={18} marginEnd={18} marginBottom={8}>
      <For each={props.permissions} id={(p: PermissionRequest) => p.id}>
        {(p: PermissionRequest) => <PermissionCard request={p} reply={props.replyPermission} />}
      </For>
      <For each={props.questions} id={(q: QuestionRequest) => q.id}>
        {(q: QuestionRequest) => <QuestionCard request={q} props={props} />}
      </For>
    </Gtk.Box>
  );
}
