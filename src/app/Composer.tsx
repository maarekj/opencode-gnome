// Zone de saisie du prompt : texte multiligne, agent, modèle, envoyer / interrompre.
// Ctrl+Entrée envoie, Entrée insère un saut de ligne (SEND_WITH_CTRL pour inverser).
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import GObject from 'gi://GObject';
import { createState, onCleanup, type Accessor } from 'gnim';
import { errorMessage } from '../shared/errors.ts';
import { attachmentFromFile, attachmentFromTexture, attachmentsFromClipboard, AttachmentView, pickFiles } from './Attachments.tsx';
import { keyedBox } from './KeyedBox.ts';
import type { Agent, Attachment, Providers } from '../shared/schemas.ts';

export interface ModelRef {
  readonly providerID: string;
  readonly modelID: string;
}

export interface ComposerProps {
  busy: Accessor<boolean>;
  /** Agent et modèle utilisés en dernier dans la session (présélection). */
  initial: () => { agent?: string; model?: ModelRef };
  loadChoices: () => Promise<{ agents: Agent[]; providers: Providers }>;
  send: (text: string, agent: string | undefined, model: ModelRef | undefined, files: readonly Attachment[]) => Promise<boolean>;
  /** Affiche un message d'erreur. */
  toast: (message: string) => void;
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
  const [files, setFiles] = createState<readonly Attachment[]>([]);
  let fileSeq = 0;
  /** clé stable par pièce jointe (pour la liste des miniatures) */
  const fileKeys = new WeakMap<Attachment, string>();
  const keyOf = (a: Attachment): string => {
    let k = fileKeys.get(a);
    if (k === undefined) {
      fileSeq += 1;
      k = String(fileSeq);
      fileKeys.set(a, k);
    }
    return k;
  };
  const addFiles = (list: readonly Attachment[]): void => {
    if (list.length > 0) setFiles([...files.peek(), ...list]);
  };
  const attach = (load: Promise<Attachment[] | null>): void => {
    load.then(
      (list) => addFiles(list ?? []),
      (e: unknown) => props.toast(`Pièce jointe impossible : ${errorMessage(e)}`),
    );
  };

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
    const attached = files.peek();
    if ((text === '' && attached.length === 0) || sending) return;
    const agent = selectedString(agentDD);
    const model = selectedString(modelDD);
    const slash = model?.indexOf('/') ?? -1;
    const ref = model === undefined || slash === -1 ? undefined : { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
    sending = true;
    const go = async (): Promise<void> => {
      const ok = await props.send(text, agent, ref, attached);
      sending = false;
      if (ok) {
        buffer.text = '';
        setFiles([]);
      }
    };
    void go();
  };

  return (
    <Gtk.Box
      orientation={Gtk.Orientation.VERTICAL}
      cssClasses={['composer', 'card']}
      marginStart={18}
      marginEnd={18}
      marginBottom={12}
      $={(self: Gtk.Box) => {
        // glisser-déposer de fichiers ou d'images sur la zone de saisie
        const drop = Gtk.DropTarget.new(GObject.TYPE_NONE, Gdk.DragAction.COPY);
        drop.set_gtypes([Gdk.FileList.$gtype, Gdk.Texture.$gtype]);
        drop.connect('drop', (_t: Gtk.DropTarget, value: unknown) => {
          if (value instanceof Gdk.FileList) attach(Promise.all(value.get_files().map((f) => attachmentFromFile(f))));
          else if (value instanceof Gdk.Texture) addFiles([attachmentFromTexture(value)]);
          else return false;
          return true;
        });
        self.add_controller(drop);
      }}
    >
      <Gtk.Box
        spacing={8}
        marginTop={10}
        marginStart={12}
        marginEnd={12}
        visible={files((f) => f.length > 0)}
        $={(self: Gtk.Box) => {
          onCleanup(
            keyedBox(self, files, keyOf, (a) => {
              const w = AttachmentView({ mime: a.mime, filename: a.filename, url: a.url, onRemove: () => setFiles(files.peek().filter((x) => x !== a)) });
              if (!(w instanceof Gtk.Widget)) throw new TypeError('widget attendu');
              return w;
            }),
          );
        }}
      />
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
            // Ctrl+V : image ou fichiers du presse-papier en pièces jointes, sinon collage normal du texte
            self.connect('paste-clipboard', () => {
              const clipboard = self.get_clipboard();
              const formats = clipboard.get_formats();
              if (!formats.contain_gtype(Gdk.FileList.$gtype) && !formats.contain_gtype(Gdk.Texture.$gtype)) return;
              GObject.signal_stop_emission_by_name(self, 'paste-clipboard');
              attach(attachmentsFromClipboard(clipboard));
            });
            // grab_focus dès que la vue est affichée
            self.connect('map', () => {
              self.grab_focus();
            });
          }}
        />
      </Gtk.ScrolledWindow>
      <Gtk.Box spacing={6} marginStart={6} marginEnd={6} marginBottom={6}>
        <Gtk.Button
          iconName="mail-attachment-symbolic"
          tooltipText="Joindre des fichiers ou des images (ou coller / glisser-déposer)"
          cssClasses={['flat', 'circular']}
          onClicked={(self: Gtk.Button) => attach(pickFiles(self))}
        />
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
