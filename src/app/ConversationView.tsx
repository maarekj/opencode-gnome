// Affichage d'une conversation : messages utilisateur, réponses (markdown), réflexion, appels d'outils.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createComputed, createMemo, createState, onCleanup, With, type Accessor } from 'gnim';
import type { Block, Conversation } from '../shared/conversation.ts';
import { esc } from '../shared/format.ts';
import type { Part, PermissionRequest, QuestionRequest, ToolState } from '../shared/schemas.ts';
import { keyedBox } from './KeyedBox.ts';
import { Markdown } from './Markdown.tsx';
import { AnsweredQuestions, PermissionCard, QuestionCard, type RequestActions } from './Requests.tsx';

/** Demande en attente d'une réponse de l'utilisateur. */
type Pending = { readonly kind: 'permission'; readonly request: PermissionRequest } | { readonly kind: 'question'; readonly request: QuestionRequest };

/** Cartes de demandes actuellement construites (id de la demande -> widget), pour la pastille. */
class CardRegistry {
  readonly #cards = new Map<string, Gtk.Widget>();
  readonly #listeners = new Set<() => void>();

  add(id: string, widget: Gtk.Widget): void {
    this.#cards.set(id, widget);
    this.#changed();
  }

  remove(id: string, widget: Gtk.Widget): void {
    if (this.#cards.get(id) === widget) this.#cards.delete(id);
    this.#changed();
  }

  get(id: string): Gtk.Widget | undefined {
    return this.#cards.get(id);
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  #changed(): void {
    for (const fn of this.#listeners) fn();
  }
}

interface FlowContext {
  readonly conversation: Conversation;
  readonly actions: RequestActions;
  readonly cards: CardRegistry;
}

const pendingList = (c: Conversation): Pending[] => [
  ...c.permissions().map((request): Pending => ({ kind: 'permission', request })),
  ...c.questions().map((request): Pending => ({ kind: 'question', request })),
];

/** Carte d'une demande, enregistrée pour la pastille tant qu'elle existe. */
function RequestCard({ pending, ctx }: { pending: Pending; ctx: FlowContext }): Gtk.Widget {
  const widget = pending.kind === 'permission' ? <PermissionCard request={pending.request} actions={ctx.actions} /> : <QuestionCard request={pending.request} actions={ctx.actions} />;
  if (!(widget instanceof Gtk.Widget)) throw new TypeError('widget attendu');
  ctx.cards.add(pending.request.id, widget);
  onCleanup(() => ctx.cards.remove(pending.request.id, widget));
  return widget;
}

const MAX_OUTPUT = 8000;

const truncate = (s: string, max = MAX_OUTPUT): string => (s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} caractères de plus)` : s);

const asText = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 2);
};

const field = (v: unknown, key: string): string | undefined => {
  if (typeof v !== 'object' || v === null || !(key in v)) return undefined;
  const value: unknown = Reflect.get(v, key);
  return typeof value === 'string' ? value : undefined;
};

/** Résumé d'un appel d'outil sur une ligne. */
function toolSummary(tool: string, state: ToolState | undefined): string {
  const input = state?.input;
  const fromInput = field(input, 'command') ?? field(input, 'filePath') ?? field(input, 'pattern') ?? field(input, 'url') ?? field(input, 'description');
  const full = state?.title ?? fromInput ?? tool;
  const lines = full.trim().split('\n');
  return lines.length > 1 ? `${lines[0] ?? ''} …` : full;
}

function Code({ text, css = [] }: { text: string; css?: string[] }): JSX.Element {
  return (
    <Gtk.Label
      label={text}
      xalign={0}
      selectable
      wrap
      wrapMode={Pango.WrapMode.CHAR}
      cssClasses={['monospace', 'tool-output', ...css]}
    />
  );
}

function StatusIcon({ status }: { status: string }): JSX.Element {
  switch (status) {
    case 'pending':
    case 'running':
      return <Adw.Spinner />;
    case 'error':
      return <Gtk.Image iconName="dialog-error-symbolic" cssClasses={['error']} />;
    default:
      return <Gtk.Image iconName="object-select-symbolic" cssClasses={['dim-label']} />;
  }
}

function ToolDetails({ part }: { part: Part }): JSX.Element {
  const state = part.state;
  const input = state?.input;
  const command = field(input, 'command');
  const output = asText(state?.output);
  const error = asText(state?.error);
  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={6} marginTop={6} marginStart={28}>
      {command === undefined ? <Code text={truncate(asText(input), 3000)} css={['dim-label']} /> : <Code text={`$ ${command}`} />}
      {output === '' ? null : <Code text={truncate(output)} />}
      {error === '' ? null : <Code text={truncate(error)} css={['error']} />}
    </Gtk.Box>
  );
}

function ToolLine({ part: p }: { part: Part }): JSX.Element {
  let expanded = false;
  const waiting = p.tool === 'question' && (p.state?.status === 'running' || p.state?.status === 'pending');
  return (
    <Gtk.Expander
      expanded={expanded}
      onNotifyExpanded={(self: Gtk.Expander) => {
        expanded = self.expanded;
      }}
    >
      <Gtk.Box $type="label" spacing={8}>
        <StatusIcon status={p.state?.status ?? 'pending'} />
        <Gtk.Label label={waiting ? 'question' : (p.tool ?? 'outil')} cssClasses={['heading']} />
        <Gtk.Label
          label={waiting ? 'en attente de réponse…' : toolSummary(p.tool ?? '', p.state)}
          ellipsize={Pango.EllipsizeMode.END}
          xalign={0}
          hexpand
          cssClasses={['dim-label', 'monospace']}
        />
      </Gtk.Box>
      <ToolDetails part={p} />
    </Gtk.Expander>
  );
}

/**
 * Appel d'outil. Si une permission ou une question attend une réponse pour cet appel, la carte
 * correspondante est affichée à sa place, dans le flux. Une question répondue devient un rappel replié.
 */
function ToolBlock({ part, ctx }: { part: Accessor<Part>; ctx: FlowContext }): JSX.Element {
  const pending = createMemo(
    (): Pending | null => {
      const callID = part().callID;
      if (callID === undefined) return null;
      return pendingList(ctx.conversation).find((p) => p.request.tool?.callID === callID) ?? null;
    },
    // la carte n'est reconstruite que si la demande change (conserve les choix en cours)
    { equals: (a, b) => a?.request.id === b?.request.id },
  );
  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} cssClasses={['tool-call']}>
      <With value={pending}>
        {(pd: Pending | null) =>
          pd === null ? (
            // Box intermédiaire : gnim ne gère pas les Fragments imbriqués (With dans With)
            <Gtk.Box orientation={Gtk.Orientation.VERTICAL}>
              <With value={part}>
                {(p: Part) =>
                  p.tool === 'question' && (p.state?.status === 'completed' || p.state?.status === 'error') ? <AnsweredQuestions part={p} /> : <ToolLine part={p} />
                }
              </With>
            </Gtk.Box>
          ) : (
            RequestCard({ pending: pd, ctx })
          )
        }
      </With>
    </Gtk.Box>
  );
}

const text = (part: Accessor<Part>): Accessor<string> => part((p) => p.text ?? '');

function BlockView({ block, ctx }: { block: Block; ctx: FlowContext }): Gtk.Widget {
  let widget: JSX.Element;
  switch (block.kind) {
    case 'user':
      widget = (
        <Gtk.Box cssClasses={['user-message']} halign={Gtk.Align.FILL}>
          <With value={text(block.part)}>{(t: string) => <Markdown text={t} />}</With>
        </Gtk.Box>
      );
      break;
    case 'text':
      widget = (
        <Gtk.Box cssClasses={['assistant-message']}>
          <With value={text(block.part)}>{(t: string) => <Markdown text={t} />}</With>
        </Gtk.Box>
      );
      break;
    case 'reasoning':
      widget = (
        <Gtk.Expander label="Réflexion" cssClasses={['reasoning']}>
          <Gtk.Box cssClasses={['dim-label']} marginTop={6} marginStart={18}>
            <With value={text(block.part)}>{(t: string) => <Markdown text={t} />}</With>
          </Gtk.Box>
        </Gtk.Expander>
      );
      break;
    case 'tool':
      widget = <ToolBlock part={block.part} ctx={ctx} />;
      break;
    case 'file':
      widget = (
        <Gtk.Box spacing={6} cssClasses={['dim-label']}>
          <Gtk.Image iconName="mail-attachment-symbolic" />
          <Gtk.Label label={block.part((p) => p.filename ?? p.mime ?? 'fichier')} />
        </Gtk.Box>
      );
      break;
    case 'error':
      widget = <Gtk.Label label={text(block.part)} xalign={0} wrap selectable cssClasses={['error']} />;
      break;
    default:
      widget = <Gtk.Label label="" />;
  }
  if (!(widget instanceof Gtk.Widget)) throw new TypeError('widget attendu');
  return widget;
}

/**
 * Garde la vue collée en bas (dernier message) pendant le chargement et le streaming,
 * sauf si l'utilisateur est remonté dans l'historique.
 */
function stickToBottom(scrolled: Gtk.ScrolledWindow): void {
  const adj = scrolled.get_vadjustment();
  // OPENCODE_GNOME_TEST_SCROLL=top : reste en haut (tests de la pastille sur captures)
  let stick = GLib.getenv('OPENCODE_GNOME_TEST_SCROLL') !== 'top';
  let lastUpper = adj.upper;
  let lastPage = adj.pageSize;
  let queued = false;
  // différé : une valeur posée pendant l'allocation (notify::upper) est écrasée par GTK
  const toBottom = (): void => {
    if (queued) return;
    queued = true;
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      queued = false;
      adj.value = adj.upper - adj.pageSize;
      lastUpper = adj.upper;
      lastPage = adj.pageSize;
      return GLib.SOURCE_REMOVE;
    });
  };
  adj.connect('value-changed', () => {
    // les changements de taille (contenu, fenêtre) ne sont pas des défilements de l'utilisateur
    if (adj.upper !== lastUpper || adj.pageSize !== lastPage) return;
    stick = adj.value + adj.pageSize >= adj.upper - 40;
  });
  const onResize = (): void => {
    lastUpper = adj.upper;
    lastPage = adj.pageSize;
    if (stick) toBottom();
  };
  adj.connect('notify::upper', onResize);
  adj.connect('notify::page-size', onResize);
}

/**
 * Pastille « demande en attente » : visible quand une demande attend une réponse et qu'aucune
 * de ses cartes n'est à l'écran. Un clic fait défiler jusqu'à la première carte.
 */
const MIN_VISIBLE = 48;

function Pastille({ ctx, scrolled }: { ctx: FlowContext; scrolled: Gtk.ScrolledWindow }): JSX.Element {
  const [visible, setVisible] = createState(false);
  const [label, setLabel] = createState('');
  const adj = scrolled.get_vadjustment();

  /** Position verticale de la carte dans la zone visible (null si elle n'est pas construite). */
  const offset = (id: string): { top: number; bottom: number } | null => {
    const card = ctx.cards.get(id);
    if (card === undefined || !card.get_mapped()) return null;
    const [ok, rect] = card.compute_bounds(scrolled);
    return ok ? { top: rect.get_y(), bottom: rect.get_y() + rect.get_height() } : null;
  };

  const update = (): void => {
    const pending = pendingList(ctx.conversation);
    const height = scrolled.get_height();
    const onScreen = pending.some((p) => {
      const o = offset(p.request.id);
      // visible = au moins MIN_VISIBLE px de la carte à l'écran
      return o !== null && o.top < height - MIN_VISIBLE && o.bottom > MIN_VISIBLE;
    });
    setVisible(pending.length > 0 && !onScreen);
    const questions = pending.filter((p) => p.kind === 'question').length;
    const permissions = pending.length - questions;
    setLabel(
      permissions === 0
        ? `${questions} question${questions > 1 ? 's' : ''} en attente`
        : questions === 0
          ? `${permissions} permission${permissions > 1 ? 's' : ''} demandée${permissions > 1 ? 's' : ''}`
          : `${pending.length} demandes en attente`,
    );
  };

  // recalcul différé : les positions ne sont à jour qu'après la mise en page de la frame suivante
  let queued = false;
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 100, () => {
      queued = false;
      update();
      return GLib.SOURCE_REMOVE;
    });
  };
  const handlers = [adj.connect('value-changed', schedule), adj.connect('notify::upper', schedule), adj.connect('notify::page-size', schedule)];
  const unsubscribe = [ctx.cards.subscribe(schedule), ctx.conversation.permissions.subscribe(schedule), ctx.conversation.questions.subscribe(schedule)];
  onCleanup(() => {
    for (const h of handlers) adj.disconnect(h);
    for (const u of unsubscribe) u();
  });

  const jump = (): void => {
    for (const p of pendingList(ctx.conversation)) {
      const o = offset(p.request.id);
      if (o !== null) {
        adj.value += o.top - 24;
        return;
      }
    }
  };

  return (
    <Gtk.Revealer
      revealChild={visible}
      transitionType={Gtk.RevealerTransitionType.CROSSFADE}
      halign={Gtk.Align.CENTER}
      valign={Gtk.Align.END}
      marginBottom={12}
      canTarget={visible}
    >
      <Gtk.Button cssClasses={['pill', 'suggested-action', 'pending-pill']} onClicked={jump}>
        <Gtk.Box spacing={8}>
          <Gtk.Image iconName="go-down-symbolic" />
          <Gtk.Label label={label} />
        </Gtk.Box>
      </Gtk.Button>
    </Gtk.Revealer>
  );
}

export function ConversationView({ conversation, revealed, actions }: { conversation: Conversation; revealed: Accessor<boolean>; actions: RequestActions }): JSX.Element {
  // spinner tant que l'animation d'entrée n'est pas finie ou que rien n'est chargé
  const showLoading = createComputed(() => !revealed() || (conversation.loading() && conversation.blocks().length === 0));
  const ctx: FlowContext = { conversation, actions, cards: new CardRegistry() };

  // demandes non rattachées à un appel d'outil affiché : en fin de conversation
  const orphans = createComputed((): Pending[] => {
    const callIDs = new Set(
      conversation
        .blocks()
        .filter((b) => b.kind === 'tool')
        .map((b) => b.part().callID),
    );
    return pendingList(conversation).filter((p) => p.request.tool === undefined || !callIDs.has(p.request.tool.callID));
  });

  /** Construit le contenu d'une boîte une fois la page affichée (pas pendant l'animation). */
  const whenRevealed = (build: () => () => void): void => {
    let stop: (() => void) | null = null;
    const start = (): void => {
      if (stop === null && revealed.peek()) stop = build();
    };
    start();
    const unsubscribe = revealed.subscribe(start);
    onCleanup(() => {
      unsubscribe();
      stop?.();
    });
  };

  const scrolled = (
    <Gtk.ScrolledWindow
      hscrollbarPolicy={Gtk.PolicyType.NEVER}
      $={(self: Gtk.ScrolledWindow) => {
        stickToBottom(self);
      }}
    >
      <Adw.Clamp maximumSize={860} tighteningThreshold={600}>
        <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={14} marginTop={18} marginBottom={24} marginStart={18} marginEnd={18}>
          <Adw.Banner
            revealed={conversation.error((e) => e !== null)}
            title={conversation.error((e) => esc(e ?? ''))}
            buttonLabel="Réessayer"
            onButtonClicked={() => void conversation.reload()}
          />
          <Gtk.Box
            orientation={Gtk.Orientation.VERTICAL}
            spacing={14}
            $={(self: Gtk.Box) => {
              whenRevealed(() => keyedBox(self, conversation.blocks, (b) => b.id, (b) => BlockView({ block: b, ctx })));
            }}
          />
          <Gtk.Box
            orientation={Gtk.Orientation.VERTICAL}
            spacing={14}
            $={(self: Gtk.Box) => {
              whenRevealed(() => keyedBox(self, orphans, (p) => p.request.id, (p) => RequestCard({ pending: p, ctx })));
            }}
          />
        </Gtk.Box>
      </Adw.Clamp>
    </Gtk.ScrolledWindow>
  );
  if (!(scrolled instanceof Gtk.ScrolledWindow)) throw new TypeError('ScrolledWindow attendue');

  return (
    <Gtk.Stack
      vexpand
      transitionType={Gtk.StackTransitionType.CROSSFADE}
      visibleChildName={showLoading((l) => (l ? 'loading' : 'messages'))}
    >
      <Adw.Spinner name="loading" $type="named" halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER} widthRequest={32} heightRequest={32} />
      <Gtk.Overlay name="messages" $type="named" child={scrolled}>
        <Pastille $type="overlay" ctx={ctx} scrolled={scrolled} />
      </Gtk.Overlay>
    </Gtk.Stack>
  );
}
