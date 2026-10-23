// Affichage d'une conversation : messages utilisateur, réponses (markdown), réflexion, appels d'outils.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createComputed, createMemo, createState, onCleanup, With, type Accessor } from 'gnim';
import { stripImageMarkers, type Block, type Conversation, type TurnInfo } from '../shared/conversation.ts';
import { AttachmentView } from './Attachments.tsx';
import { esc, fmtDuration, fmtFullDate, fmtStamp } from '../shared/format.ts';
import type { Part, PermissionRequest, QuestionRequest, ToolState } from '../shared/schemas.ts';
import { keyedBox } from './KeyedBox.ts';
import { MarkdownView } from './Markdown.tsx';
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
  /** afficher les appels d'outils (bascule globale) */
  readonly showTools: Accessor<boolean>;
}

/**
 * Appel d'outil toujours affiché, même quand les outils sont masqués : erreur, ou question
 * (dialogue avec l'utilisateur plutôt qu'outillage).
 */
const alwaysShown = (p: Part): boolean => p.state?.status === 'error' || p.tool === 'question';

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
  // masqué par la bascule, sauf demande en attente, erreur ou question
  const visible = createComputed(() => ctx.showTools() || pending() !== null || alwaysShown(part()));
  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} cssClasses={['tool-call']} visible={visible}>
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

/** « Réflexion · 5,5 s », « Réflexion… » pendant la génération. */
const reasoningLabel = (p: Part): string => {
  const { start, end } = p.time ?? {};
  if (start === undefined) return 'Réflexion';
  if (end === undefined) return 'Réflexion…';
  // réflexion instantanée (résumé vide) : pas de « 0,0 s »
  return end - start < 100 ? 'Réflexion' : `Réflexion · ${fmtDuration(end - start)}`;
};

/** Heure d'un message, date complète en infobulle. */
function Stamp({ ms }: { ms: number }): JSX.Element {
  return <Gtk.Label label={fmtStamp(ms)} tooltipText={fmtFullDate(ms)} halign={Gtk.Align.END} cssClasses={['dim-label', 'caption', 'stamp']} />;
}

const turnLabel = (t: TurnInfo): string => (t.completed === undefined ? '' : `${fmtStamp(t.completed)} · répondu en ${fmtDuration(t.completed - t.created)}`);
const turnTooltip = (t: TurnInfo): string => (t.completed === undefined ? '' : `Terminé le ${fmtFullDate(t.completed)}`);

/** Pied de tour de l'agent : heure de fin et durée totale du tour (rien tant qu'il est en cours). */
function TurnFooter({ turn }: { turn: Accessor<TurnInfo> | undefined }): JSX.Element {
  if (turn === undefined) return <Gtk.Box />;
  return (
    <Gtk.Label
      label={turn(turnLabel)}
      tooltipText={turn(turnTooltip)}
      visible={turn((t) => t.completed !== undefined)}
      halign={Gtk.Align.START}
      cssClasses={['dim-label', 'caption', 'stamp']}
    />
  );
}

/** Copie du texte dans le presse-papier. */
function copyText(widget: Gtk.Widget, value: string): void {
  widget.get_clipboard().set_content(Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', new GLib.Bytes(new TextEncoder().encode(value))));
}

/**
 * Message en markdown, sélectionnable d'un bloc (un seul TextView), avec un bouton « Copier »
 * (markdown source) qui apparaît au survol.
 */
function Copyable({ text: source, css }: { text: Accessor<string>; css: string }): JSX.Element {
  return (
    <Gtk.Overlay cssClasses={['copyable', css]}>
      <Gtk.Box orientation={Gtk.Orientation.VERTICAL}>
        <With value={source}>{(t: string) => MarkdownView({ text: t })}</With>
      </Gtk.Box>
      <Gtk.Button
        $type="overlay"
        iconName="edit-copy-symbolic"
        tooltipText="Copier le message (markdown)"
        halign={Gtk.Align.END}
        valign={Gtk.Align.START}
        cssClasses={['flat', 'circular', 'copy-button']}
        onClicked={(self: Gtk.Button) => {
          copyText(self, source.peek());
          self.iconName = 'object-select-symbolic';
          GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
            self.iconName = 'edit-copy-symbolic';
            return GLib.SOURCE_REMOVE;
          });
        }}
      />
    </Gtk.Overlay>
  );
}

function BlockView({ block, ctx }: { block: Block; ctx: FlowContext }): Gtk.Widget {
  let widget: JSX.Element;
  switch (block.kind) {
    case 'user':
      widget = (
        <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
          {block.first === true ? <Stamp ms={block.created} /> : null}
          <Copyable text={block.part((p) => stripImageMarkers(p.text ?? ''))} css="user-message" />
        </Gtk.Box>
      );
      break;
    case 'turn':
      widget = <TurnFooter turn={block.turn} />;
      break;
    case 'text':
      widget = <Copyable text={text(block.part)} css="assistant-message" />;
      break;
    case 'reasoning':
      widget = (
        <Gtk.Expander label={block.part(reasoningLabel)} cssClasses={['reasoning']}>
          <Gtk.Box cssClasses={['dim-label']} marginTop={6} marginStart={18}>
            <With value={text(block.part)}>{(t: string) => MarkdownView({ text: t })}</With>
          </Gtk.Box>
        </Gtk.Expander>
      );
      break;
    case 'tool':
      widget = <ToolBlock part={block.part} ctx={ctx} />;
      break;
    case 'file': {
      // contenu figé : une pièce jointe ne change pas une fois envoyée
      const p = block.part.peek();
      widget = (
        <Gtk.Box halign={Gtk.Align.START} cssClasses={['message-attachment']}>
          <AttachmentView mime={p.mime} filename={p.filename} url={p.url ?? ''} />
        </Gtk.Box>
      );
      break;
    }
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
 * Garde la position de lecture quand les outils sont masqués / affichés : le premier bloc
 * visible en haut de l'écran (hors outils) reste au même endroit après la bascule.
 */
function keepReadingPosition(blocks: Gtk.Box, showTools: Accessor<boolean>): void {
  const unsubscribe = showTools.subscribe(() => {
    const scrolled = blocks.get_ancestor(Gtk.ScrolledWindow.$gtype);
    if (!(scrolled instanceof Gtk.ScrolledWindow)) return;
    const adj = scrolled.get_vadjustment();
    // collé en bas : stickToBottom s'en charge
    if (adj.value + adj.pageSize >= adj.upper - 40) return;
    // ancre : premier message (pas un outil) dont le bas est sous le haut de l'écran
    let anchor: Gtk.Widget | null = null;
    let before = 0;
    for (let w = blocks.get_first_child(); w !== null; w = w.get_next_sibling()) {
      if (w.has_css_class('tool-call') || !w.get_visible()) continue;
      const [ok, rect] = w.compute_bounds(scrolled);
      if (ok && rect.get_y() + rect.get_height() > 0) {
        anchor = w;
        before = rect.get_y();
        break;
      }
    }
    if (anchor === null) return;
    const target = anchor;
    // après la nouvelle mise en page, recaler l'ancre au même endroit
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      const [ok, rect] = target.compute_bounds(scrolled);
      if (ok) adj.value += rect.get_y() - before;
      return GLib.SOURCE_REMOVE;
    });
  });
  onCleanup(unsubscribe);
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

export function ConversationView({
  conversation,
  revealed,
  actions,
  showTools,
}: {
  conversation: Conversation;
  revealed: Accessor<boolean>;
  actions: RequestActions;
  showTools: Accessor<boolean>;
}): JSX.Element {
  // spinner tant que l'animation d'entrée n'est pas finie ou que rien n'est chargé
  const showLoading = createComputed(() => !revealed() || (conversation.loading() && conversation.blocks().length === 0));
  const ctx: FlowContext = { conversation, actions, cards: new CardRegistry(), showTools };

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
        <Gtk.Box
          orientation={Gtk.Orientation.VERTICAL}
          spacing={14}
          marginTop={18}
          marginBottom={24}
          marginStart={18}
          marginEnd={18}
        >
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
              keepReadingPosition(self, showTools);
              whenRevealed(() => {
                const t0 = Date.now();
                const stop = keyedBox(self, conversation.blocks, (b) => b.id, (b) => BlockView({ block: b, ctx }));
                if (GLib.getenv('OPENCODE_GNOME_TIMING') !== null) console.log(`TIMING blocs=${conversation.blocks.peek().length} ${Date.now() - t0} ms`);
                return stop;
              });
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
