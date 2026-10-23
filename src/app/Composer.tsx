// Zone de saisie du prompt : texte multiligne, agent, modèle, envoyer / interrompre.
// Ctrl+Entrée envoie, Entrée insère un saut de ligne (SEND_WITH_CTRL pour inverser).
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import GObject from 'gi://GObject';
import { createComputed, createState, onCleanup, type Accessor } from 'gnim';
import type { ContextUsage } from '../shared/conversation.ts';
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
  /** Agent, modèle et niveau de raisonnement de la session (présélection). */
  initial: () => { agent?: string; model?: ModelRef; variant?: string };
  loadChoices: () => Promise<{ agents: Agent[]; providers: Providers }>;
  send: (text: string, choice: { agent?: string; model?: ModelRef; variant?: string }, files: readonly Attachment[]) => Promise<boolean>;
  /** Contexte utilisé par la session. */
  context: Accessor<ContextUsage | null>;
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

/** Libellé « Par défaut » du menu de raisonnement (aucune variante envoyée). */
const DEFAULT_VARIANT = 'Par défaut';

const selectedString = (dd: Gtk.DropDown): string | undefined => {
  const item = dd.selectedItem;
  return item instanceof Gtk.StringObject ? item.string : undefined;
};

const fmtTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)} M` : n >= 1000 ? `${Math.round(n / 1000)} k` : String(n));

/** Classe d'alerte selon le remplissage du contexte. */
const level = (r: number | null): string => (r === null || r < 0.8 ? '' : r < 0.95 ? 'warning' : 'error');

/** Taille du contexte : « 152 k · 15 % » et jauge ; alerte au-delà de 80 %, critique au-delà de 95 %. */
function ContextGauge({ context, limits }: { context: Accessor<ContextUsage | null>; limits: Accessor<ReadonlyMap<string, number>> }): JSX.Element {
  const info = createComputed(() => {
    const c = context();
    if (c === null) return null;
    const limit = limits().get(`${c.providerID}/${c.modelID}`) ?? null;
    return { ...c, limit, ratio: limit === null ? null : Math.min(1, c.tokens / limit) };
  });
  return (
    <Gtk.Box
      spacing={6}
      valign={Gtk.Align.CENTER}
      visible={info((i) => i !== null)}
      cssClasses={['context-gauge']}
      tooltipText={info((i) =>
        i === null
          ? ''
          : [
              `Contexte : ${i.tokens.toLocaleString('fr-FR')} tokens`,
              i.limit === null ? 'Limite du modèle inconnue' : `Limite : ${i.limit.toLocaleString('fr-FR')} tokens (${Math.round((i.ratio ?? 0) * 100)} %)`,
              `Modèle : ${i.providerID}/${i.modelID}${i.variant === undefined ? '' : ` (${i.variant})`}`,
              ...(i.cost > 0 ? [`Coût : ${i.cost.toFixed(2)} $`] : []),
            ].join('\n'),
      )}
    >
      <Gtk.LevelBar
        valign={Gtk.Align.CENTER}
        widthRequest={48}
        minValue={0}
        maxValue={1}
        value={info((i) => i?.ratio ?? 0)}
        visible={info((i) => i?.ratio !== null)}
        cssClasses={info((i) => ['context-bar', level(i?.ratio ?? null)])}
        $={(self: Gtk.LevelBar) => {
          // couleurs gérées par les classes, pas par les seuils par défaut de GTK
          for (const name of ['low', 'high', 'full']) self.remove_offset_value(name);
        }}
      />
      <Gtk.Label
        cssClasses={info((i) => ['caption', 'numeric', level(i?.ratio ?? null) || 'dim-label'])}
        label={info((i) => (i === null ? '' : i.ratio === null ? fmtTokens(i.tokens) : `${fmtTokens(i.tokens)} · ${Math.round(i.ratio * 100)} %`))}
      />
    </Gtk.Box>
  );
}

export function Composer(props: ComposerProps): JSX.Element {
  const agentDD = stringDropDown('Agent', false);
  const modelDD = stringDropDown('Modèle', true);
  const variantDD = stringDropDown('Niveau de raisonnement (Ctrl+T)', false);
  variantDD.visible = false;
  /** « fournisseur/modèle » -> variantes disponibles, dans l'ordre du serveur */
  let variants = new Map<string, readonly string[]>();
  /** agent -> variante définie dans sa config */
  let agentVariants = new Map<string, string>();
  /** Remplit le menu de raisonnement pour le modèle sélectionné, en gardant `wanted` s'il existe. */
  const fillVariants = (wanted: string | undefined): void => {
    const list = variants.get(selectedString(modelDD) ?? '') ?? [];
    variantDD.visible = list.length > 0;
    fill(variantDD, [DEFAULT_VARIANT, ...list], wanted !== undefined && list.includes(wanted) ? wanted : DEFAULT_VARIANT);
  };
  modelDD.connect('notify::selected', () => fillVariants(selectedString(variantDD)));
  /** Passe à la variante suivante (Ctrl+T, comme la console). */
  const cycleVariant = (): void => {
    const n = variantDD.model?.get_n_items() ?? 0;
    if (variantDD.visible && n > 1) variantDD.selected = (variantDD.selected + 1) % n;
  };
  const buffer = new Gtk.TextBuffer();
  let sending = false;
  const [files, setFiles] = createState<readonly Attachment[]>([]);
  /** « fournisseur/modèle » -> taille de la fenêtre de contexte */
  const [limits, setLimits] = createState<ReadonlyMap<string, number>>(new Map());
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
      agentVariants = new Map(agents.flatMap((a) => (typeof a.variant === 'string' ? [[a.name, a.variant] as const] : [])));
      variants = new Map(providers.providers.flatMap((p) => Object.entries(p.models).map(([id, m]) => [`${p.id}/${id}`, Object.keys(m.variants ?? {})] as const)));
      fill(agentDD, names, init.agent ?? 'build');
      setLimits(
        new Map(
          providers.providers.flatMap((p) =>
            Object.entries(p.models).flatMap(([id, m]) => (m.limit === undefined ? [] : [[`${p.id}/${id}`, m.limit.context] as const])),
          ),
        ),
      );
      const models = providers.providers.flatMap((p) => Object.keys(p.models).map((id) => `${p.id}/${id}`)).toSorted();
      const fallback = Object.entries(providers.default).map(([p, m]) => `${p}/${m}`)[0];
      fill(modelDD, models, init.model === undefined ? fallback : modelKey(init.model));
      fillVariants(init.variant ?? agentVariants.get(init.agent ?? 'build'));
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
    const variant = variantDD.visible ? selectedString(variantDD) : undefined;
    const slash = model?.indexOf('/') ?? -1;
    const choice = {
      ...(agent === undefined ? {} : { agent }),
      ...(model === undefined || slash === -1 ? {} : { model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } }),
      ...(variant === undefined || variant === DEFAULT_VARIANT ? {} : { variant }),
    };
    sending = true;
    const go = async (): Promise<void> => {
      const ok = await props.send(text, choice, attached);
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
              if (ctrl && (keyval === Gdk.KEY_t || keyval === Gdk.KEY_T)) {
                cycleVariant();
                return true;
              }
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
        {variantDD}
        <Gtk.Label
          hexpand
          xalign={1}
          ellipsize={Pango.EllipsizeMode.END}
          cssClasses={['dim-label', 'caption']}
          label={HINT}
        />
        <ContextGauge context={props.context} limits={limits} />
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
