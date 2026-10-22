// Zone de saisie du prompt : texte multiligne, agent, modèle, envoyer / interrompre.
// Ctrl+Entrée envoie, Entrée insère un saut de ligne (SEND_WITH_CTRL pour inverser).
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import type { Accessor } from 'gnim';
import type { Agent, Providers } from '../shared/schemas.ts';

export interface ModelRef {
  readonly providerID: string;
  readonly modelID: string;
}

export interface ComposerProps {
  busy: Accessor<boolean>;
  /** Agent et modèle utilisés en dernier dans la session (présélection). */
  initial: () => { agent?: string; model?: ModelRef };
  loadChoices: () => Promise<{ agents: Agent[]; providers: Providers }>;
  send: (text: string, agent: string | undefined, model: ModelRef | undefined) => Promise<boolean>;
  abort: () => void;
}

/** true : Ctrl+Entrée envoie, Entrée = saut de ligne. false : Entrée envoie, Maj+Entrée = saut de ligne. */
const SEND_WITH_CTRL = true;

const HINT = SEND_WITH_CTRL ? 'Ctrl+Entrée pour envoyer' : 'Entrée pour envoyer · Maj+Entrée pour un saut de ligne';

const modelKey = (m: ModelRef): string => `${m.providerID}/${m.modelID}`;

/** Gtk.DropDown de chaînes, avec recherche optionnelle. */
function stringDropDown(tooltip: string, search: boolean): Gtk.DropDown {
  const dd = Gtk.DropDown.new_from_strings([]);
  dd.tooltipText = tooltip;
  dd.valign = Gtk.Align.CENTER;
  dd.enableSearch = search;
  dd.cssClasses = ['flat'];
  if (search) {
    dd.expression = Gtk.PropertyExpression.new(Gtk.StringObject.$gtype, null, 'string');
    dd.searchMatchMode = Gtk.StringFilterMatchMode.SUBSTRING;
  }
  return dd;
}

function fill(dd: Gtk.DropDown, items: readonly string[], selected: string | undefined): void {
  dd.model = Gtk.StringList.new([...items]);
  const index = selected === undefined ? -1 : items.indexOf(selected);
  dd.selected = index === -1 ? 0 : index;
}

const selectedString = (dd: Gtk.DropDown): string | undefined => {
  const item = dd.selectedItem;
  return item instanceof Gtk.StringObject ? item.string : undefined;
};

export function Composer(props: ComposerProps): JSX.Element {
  const agentDD = stringDropDown('Agent', false);
  const modelDD = stringDropDown('Modèle', true);
  const buffer = new Gtk.TextBuffer();
  let sending = false;

  const choose = async (): Promise<void> => {
    try {
      const { agents, providers } = await props.loadChoices();
      const init = props.initial();
      const names = agents.filter((a) => a.mode !== 'subagent' && a.hidden !== true).map((a) => a.name);
      fill(agentDD, names, init.agent ?? 'build');
      const models = providers.providers.flatMap((p) => Object.keys(p.models).map((id) => `${p.id}/${id}`)).toSorted();
      const fallback = Object.entries(providers.default).map(([p, m]) => `${p}/${m}`)[0];
      fill(modelDD, models, init.model === undefined ? fallback : modelKey(init.model));
    } catch (e) {
      console.error(e);
    }
  };
  void choose();

  const submit = (): void => {
    const text = buffer.text.trim();
    if (text === '' || sending) return;
    const agent = selectedString(agentDD);
    const model = selectedString(modelDD);
    const slash = model?.indexOf('/') ?? -1;
    const ref = model === undefined || slash === -1 ? undefined : { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
    sending = true;
    const go = async (): Promise<void> => {
      const ok = await props.send(text, agent, ref);
      sending = false;
      if (ok) buffer.text = '';
    };
    void go();
  };

  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} cssClasses={['composer', 'card']} marginStart={18} marginEnd={18} marginBottom={12}>
      <Gtk.ScrolledWindow hscrollbarPolicy={Gtk.PolicyType.NEVER} propagateNaturalHeight maxContentHeight={240}>
        <Gtk.TextView
          buffer={buffer}
          wrapMode={Gtk.WrapMode.WORD_CHAR}
          acceptsTab={false}
          topMargin={10}
          bottomMargin={6}
          leftMargin={12}
          rightMargin={12}
          cssClasses={['composer-text']}
          $={(self: Gtk.TextView) => {
            const keys = new Gtk.EventControllerKey();
            keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number, _code: number, state: Gdk.ModifierType) => {
              const enter = keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter;
              const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
              const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
              if (enter && (SEND_WITH_CTRL ? ctrl : !shift && !ctrl)) {
                submit();
                return true;
              }
              return false;
            });
            self.add_controller(keys);
            // grab_focus dès que la vue est affichée
            self.connect('map', () => {
              self.grab_focus();
            });
          }}
        />
      </Gtk.ScrolledWindow>
      <Gtk.Box spacing={6} marginStart={6} marginEnd={6} marginBottom={6}>
        {agentDD}
        {modelDD}
        <Gtk.Label
          hexpand
          xalign={1}
          ellipsize={Pango.EllipsizeMode.END}
          cssClasses={['dim-label', 'caption']}
          label={HINT}
        />
        <Gtk.Button
          iconName="media-playback-stop-symbolic"
          tooltipText="Interrompre"
          cssClasses={['circular', 'destructive-action']}
          visible={props.busy}
          onClicked={() => {
            props.abort();
          }}
        />
        <Gtk.Button iconName="go-up-symbolic" tooltipText={SEND_WITH_CTRL ? 'Envoyer (Ctrl+Entrée)' : 'Envoyer (Entrée)'} cssClasses={['circular', 'suggested-action']} onClicked={submit} />
      </Gtk.Box>
    </Gtk.Box>
  );
}
