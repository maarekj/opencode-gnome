// Affichage d'une conversation : messages utilisateur, réponses (markdown), réflexion, appels d'outils.
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createComputed, onCleanup, With, type Accessor } from 'gnim';
import type { Block, Conversation } from '../shared/conversation.ts';
import { esc } from '../shared/format.ts';
import type { Part, ToolState } from '../shared/schemas.ts';
import { keyedBox } from './KeyedBox.ts';
import { Markdown } from './Markdown.tsx';

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

function ToolBlock({ part }: { part: Accessor<Part> }): JSX.Element {
  let expanded = false; // conservé entre deux mises à jour de la partie
  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} cssClasses={['tool-call']}>
      <With value={part}>
        {(p: Part) => (
          <Gtk.Expander
            expanded={expanded}
            onNotifyExpanded={(self: Gtk.Expander) => {
              expanded = self.expanded;
            }}
          >
            <Gtk.Box $type="label" spacing={8}>
              <StatusIcon status={p.state?.status ?? 'pending'} />
              <Gtk.Label label={p.tool ?? 'outil'} cssClasses={['heading']} />
              <Gtk.Label label={toolSummary(p.tool ?? '', p.state)} ellipsize={Pango.EllipsizeMode.END} xalign={0} hexpand cssClasses={['dim-label', 'monospace']} />
            </Gtk.Box>
            <ToolDetails part={p} />
          </Gtk.Expander>
        )}
      </With>
    </Gtk.Box>
  );
}

const text = (part: Accessor<Part>): Accessor<string> => part((p) => p.text ?? '');

function BlockView({ block }: { block: Block }): Gtk.Widget {
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
      widget = <ToolBlock part={block.part} />;
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
  let stick = true;
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

export function ConversationView({ conversation, revealed }: { conversation: Conversation; revealed: Accessor<boolean> }): JSX.Element {
  // spinner tant que l'animation d'entrée n'est pas finie ou que rien n'est chargé
  const showLoading = createComputed(() => !revealed() || (conversation.loading() && conversation.blocks().length === 0));
  return (
    <Gtk.Stack
      vexpand
      transitionType={Gtk.StackTransitionType.CROSSFADE}
      visibleChildName={showLoading((l) => (l ? 'loading' : 'messages'))}
    >
      <Adw.Spinner name="loading" $type="named" halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER} widthRequest={32} heightRequest={32} />
      <Gtk.ScrolledWindow
        name="messages"
        $type="named"
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
                // les widgets ne sont construits qu'une fois la page affichée (pas pendant l'animation)
                let stop: (() => void) | null = null;
                const start = (): void => {
                  if (stop === null && revealed.peek()) stop = keyedBox(self, conversation.blocks, (b) => b.id, (b) => BlockView({ block: b }));
                };
                start();
                const unsubscribe = revealed.subscribe(start);
                onCleanup(() => {
                  unsubscribe();
                  stop?.();
                });
              }}
            />
          </Gtk.Box>
        </Adw.Clamp>
      </Gtk.ScrolledWindow>
    </Gtk.Stack>
  );
}
