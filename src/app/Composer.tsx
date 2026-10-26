// Zone de saisie du prompt : texte multiligne, agent, modèle, envoyer / interrompre.
// Ctrl+Entrée envoie, Entrée insère un saut de ligne (SEND_WITH_CTRL pour inverser).
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import GObject from 'gi://GObject';
import { createComputed, createState, onCleanup, type Accessor } from 'gnim';
import type { ContextUsage } from '../shared/conversation.ts';
import { errorMessage } from '../shared/errors.ts';
import { attachmentFromFile, attachmentFromTexture, attachmentsFromClipboard, AttachmentView, pickFiles } from './Attachments.tsx';
import { CompletionPopover, type CompletionItem } from './Completion.ts';
import { keyedBox } from './KeyedBox.ts';
import { dictation, fmtElapsed, voiceSettings } from './Voice.ts';
import type { Agent, Attachment, Command, Mention, Providers } from '../shared/schemas.ts';

export interface ModelRef {
  readonly providerID: string;
  readonly modelID: string;
}

/** Agent, modèle et niveau de raisonnement choisis dans le compositeur. */
export interface Choice {
  readonly agent?: string;
  readonly model?: ModelRef;
  readonly variant?: string;
}

/** Contenu d'un envoi : pièces jointes et mentions `@` encore présentes dans le texte. */
export interface Payload {
  readonly files: readonly Attachment[];
  readonly mentions: readonly Mention[];
}

/** Commande propre à l'app (équivalent des commandes intégrées de la TUI). */
export interface BuiltinCommand {
  readonly name: string;
  readonly description: string;
  /** arguments attendus, affichés en texte indicatif */
  readonly hints?: string;
  /** Exécute la commande ; un texte retourné remplace le contenu de la zone de saisie. */
  readonly run: (args: string, choice: Choice) => Promise<string | null>;
}

export interface ComposerProps {
  busy: Accessor<boolean>;
  /** texte pré-rempli (fork depuis un message : le message à renvoyer ou modifier) */
  initialText?: string;
  /** Agent, modèle et niveau de raisonnement de la session (présélection). */
  initial: () => Choice;
  /**
   * Agents, modèles et défauts. `defaults` : modèles à présélectionner pour une session sans
   * modèle, par priorité (le premier qui existe) ; `defaultVariant` : variante associée au premier.
   */
  loadChoices: () => Promise<{
    agents: Agent[];
    providers: Providers;
    defaults: readonly string[];
    defaultVariant?: string;
  }>;
  send: (text: string, choice: Choice, payload: Payload) => Promise<boolean>;
  /** Commandes du serveur pour le répertoire de la session. */
  loadCommands: () => Promise<Command[]>;
  /** Exécute une commande du serveur (`POST /session/{id}/command`). */
  runCommand: (name: string, args: string, choice: Choice, payload: Payload) => Promise<boolean>;
  builtins: readonly BuiltinCommand[];
  /** Recherche floue de fichiers ou dossiers du projet (chemins relatifs, dossiers terminés par `/`). */
  findFiles: (query: string, cancellable: Gio.Cancellable) => Promise<string[]>;
  /** Prompts déjà envoyés dans la session, du plus ancien au plus récent. */
  history: () => readonly string[];
  /** Contexte utilisé par la session. */
  context: Accessor<ContextUsage | null>;
  /** Affiche un message d'erreur. */
  toast: (message: string) => void;
  abort: () => void;
}

/** true : Ctrl+Entrée envoie, Entrée = saut de ligne. false : Entrée envoie, Maj+Entrée = saut de ligne. */
const SEND_WITH_CTRL = true;

const HINT = SEND_WITH_CTRL ? 'Ctrl+Entrée pour envoyer' : 'Entrée pour envoyer · Maj+Entrée pour un saut de ligne';

/** raccourci de la dictée */
const DICTATION_KEY = 'Ctrl+M';
/** au-delà (ms), le raccourci maintenu termine la dictée au relâchement */
const HOLD_MS = 400;

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

const SOURCE_BADGE: Readonly<Record<string, string>> = {
  command: 'commande',
  skill: 'skill',
  mcp: 'MCP',
};

/** Arguments attendus d'une commande du serveur : `$ARGUMENTS` -> « arguments », `$1 $2` tels quels. */
const hintsText = (hints: readonly string[] | null | undefined): string | undefined => {
  const list = (hints ?? []).map((h) => (h === '$ARGUMENTS' ? 'arguments' : h));
  return list.length === 0 ? undefined : list.join(' ');
};

/** Filtre insensible à la casse : correspondances par préfixe d'abord, puis par sous-chaîne. */
function rank<T>(items: readonly T[], query: string, name: (t: T) => string): T[] {
  const q = query.toLowerCase();
  const prefix = items.filter((t) => name(t).toLowerCase().startsWith(q));
  const inner = items.filter((t) => !name(t).toLowerCase().startsWith(q) && name(t).toLowerCase().includes(q));
  return [...prefix, ...inner];
}

/** Commande proposée : intégrée à l'app ou du serveur. */
interface CommandEntry {
  readonly name: string;
  readonly description: string;
  readonly badge: string;
  readonly hints: string | undefined;
  readonly builtin?: BuiltinCommand;
}

/** Délai d'anti-rebond de la recherche de fichiers (ms). */
const FIND_DELAY_MS = 100;
const FIND_LIMIT = 20;

const folderIcon = Gio.content_type_get_symbolic_icon('inode/directory');

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
      const { agents, providers, defaults, defaultVariant } = await props.loadChoices();
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
      // session sans modèle : préférences / config opencode, sinon défaut des fournisseurs
      const preferred = defaults.find((m) => models.includes(m));
      const fallback = preferred ?? Object.entries(providers.default).map(([p, m]) => `${p}/${m}`)[0];
      fill(modelDD, models, init.model === undefined ? fallback : modelKey(init.model));
      const sessionVariant = init.variant === 'default' ? undefined : init.variant;
      // la variante par défaut des préférences ne vaut que pour le modèle par défaut des préférences
      const prefVariant = init.model === undefined && preferred !== undefined && preferred === defaults[0] ? defaultVariant : undefined;
      fillVariants(sessionVariant ?? prefVariant ?? agentVariants.get(init.agent ?? 'build'));
    } catch (e) {
      console.error(e);
    }
  };
  void choose();

  // ---------------------------------------------------------------- commandes « / »
  /** Commandes du serveur (rechargées à chaque ouverture de la liste) */
  let serverCommands: readonly Command[] = [];
  const loadCommands = async (): Promise<void> => {
    try {
      serverCommands = await props.loadCommands();
    } catch (e) {
      console.error(e);
    }
  };
  void loadCommands();
  const commandEntries = (): CommandEntry[] => {
    const builtins = props.builtins.map((b): CommandEntry => ({ name: b.name, description: b.description, badge: 'intégrée', builtin: b, hints: b.hints }));
    const taken = new Set(builtins.map((b) => b.name));
    const server = serverCommands
      .filter((c) => !taken.has(c.name))
      .map((c): CommandEntry => ({ name: c.name, description: c.description ?? '', badge: SOURCE_BADGE[c.source ?? 'command'] ?? c.source ?? 'commande', hints: hintsText(c.hints) }));
    return [...builtins, ...server];
  };
  /** Commande désignée par le premier mot du texte (`/nom …`), si elle existe. */
  const commandOf = (text: string): { entry: CommandEntry; args: string } | null => {
    const m = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(text);
    if (m === null) return null;
    const entry = commandEntries().find((c) => c.name === m[1]);
    return entry === undefined ? null : { entry, args: (m[2] ?? '').trim() };
  };
  /** Texte indicatif : arguments attendus par la commande en cours de saisie. */
  const [hint, setHint] = createState(HINT);

  // ---------------------------------------------------------------- mentions « @ »
  const mentionTag = new Gtk.TextTag({
    name: 'mention',
    foreground: '#3584e4',
    underline: 1 /* Pango.Underline.SINGLE */,
  });
  buffer.tagTable.add(mentionTag);
  /** `@chemin` inséré par complétion -> dossier ou non */
  const mentioned = new Map<string, boolean>();
  /** Plages de mentions encore intactes, dans l'ordre du texte. */
  const mentionRanges = (): {
    start: Gtk.TextIter;
    end: Gtk.TextIter;
    text: string;
  }[] => {
    const out: { start: Gtk.TextIter; end: Gtk.TextIter; text: string }[] = [];
    const it = buffer.get_start_iter();
    for (;;) {
      if (!it.starts_tag(mentionTag) && !it.forward_to_tag_toggle(mentionTag)) break;
      if (!it.starts_tag(mentionTag)) break;
      const start = it.copy();
      it.forward_to_tag_toggle(mentionTag);
      const end = it.copy();
      const text = buffer.get_slice(start, end, true);
      // modifiée à la main (texte collé derrière, caractères effacés) : plus une mention
      const after = end.get_char();
      if (mentioned.has(text) && (end.is_end() || /\s/u.test(after))) out.push({ start, end, text });
      if (end.is_end()) break;
    }
    return out;
  };
  /** Mentions du texte envoyé (`trimmed` : nombre de caractères retirés en tête). */
  const collectMentions = (trimmed: number): Mention[] =>
    mentionRanges().map(({ start, text }) => {
      const offset = buffer.get_slice(buffer.get_start_iter(), start, true).length - trimmed;
      return {
        path: text.slice(1),
        directory: mentioned.get(text) === true,
        start: offset,
        end: offset + text.length,
      };
    });

  // ---------------------------------------------------------------- historique (#21)
  /** position dans l'historique (0 = prompt le plus récent), null hors historique */
  let historyIndex: number | null = null;
  let historyList: readonly string[] = [];
  /** modification du texte par l'app (rappel, complétion) : ne quitte pas l'historique */
  let programmatic = false;
  const setText = (text: string): void => {
    programmatic = true;
    buffer.text = text;
    buffer.place_cursor(buffer.get_end_iter());
    programmatic = false;
  };
  if (props.initialText !== undefined && props.initialText !== '') setText(props.initialText);
  const historyEntries = (): string[] => {
    const out: string[] = [];
    for (const t of props.history().toReversed()) if (t !== '' && out.at(-1) !== t) out.push(t);
    return out;
  };

  // ---------------------------------------------------------------- envoi
  /** Vide le texte (les pièces jointes restent). */
  const clearText = (): void => {
    setText('');
    mentioned.clear();
    historyIndex = null;
  };
  const clear = (): void => {
    clearText();
    setFiles([]);
  };
  const submit = (): void => {
    const raw = buffer.text;
    const text = raw.trim();
    const attached = files.peek();
    if ((text === '' && attached.length === 0) || sending) return;
    const agent = selectedString(agentDD);
    const model = selectedString(modelDD);
    const variant = variantDD.visible ? selectedString(variantDD) : undefined;
    const slash = model?.indexOf('/') ?? -1;
    const choice: Choice = {
      ...(agent === undefined ? {} : { agent }),
      ...(model === undefined || slash === -1
        ? {}
        : {
            model: {
              providerID: model.slice(0, slash),
              modelID: model.slice(slash + 1),
            },
          }),
      ...(variant === undefined || variant === DEFAULT_VARIANT ? {} : { variant }),
    };
    const payload: Payload = {
      files: attached,
      mentions: collectMentions(raw.length - raw.trimStart().length),
    };
    const command = commandOf(text);
    sending = true;
    const go = async (): Promise<void> => {
      if (command?.entry.builtin !== undefined) {
        const builtin = command.entry.builtin;
        // commande intégrée (/compact, /new…) : les pièces jointes ne sont pas utilisées, gardées (#84)
        clearText();
        sending = false;
        try {
          const restored = await builtin.run(command.args, choice);
          if (restored !== null && buffer.text === '') setText(restored);
        } catch (e) {
          props.toast(`/${builtin.name} : ${errorMessage(e)}`);
          if (buffer.text === '') setText(text);
        }
        return;
      }
      if (command !== null) {
        // la requête ne répond qu'à la fin du tour : la zone de saisie est libérée tout de suite
        clear();
        sending = false;
        const ok = await props.runCommand(command.entry.name, command.args, choice, payload);
        if (!ok && buffer.text === '') setText(text);
        return;
      }
      const ok = await props.send(text, choice, payload);
      sending = false;
      if (!ok) return;
      // saisi ou joint pendant l'envoi : conservé, seul ce qui a été envoyé est retiré (#84)
      if (buffer.text === raw) clearText();
      setFiles(files.peek().filter((f) => !attached.includes(f)));
    };
    void go();
  };

  // ---------------------------------------------------------------- dictée
  /** cette zone de saisie a lancé la dictée en cours (une seule dans l'application) */
  let dictating = false;
  const [voiceStatus, setVoiceStatus] = createState('');
  const dictationLabel = createComputed(() => {
    const state = dictation.state();
    const status = voiceStatus();
    if (state === 'recording') return `Dictée ${fmtElapsed(dictation.elapsed())} · ${DICTATION_KEY} ou clic pour terminer, Échap pour annuler`;
    return status;
  });
  // texte dicté : plage entre deux marques, aperçu en italique grisé remplacé au fil de la dictée
  const dictationTag = new Gtk.TextTag({ name: 'dictation', style: 2 /* Pango.Style.ITALIC */, foreground: '#77767b' });
  buffer.tagTable.add(dictationTag);
  let dictStart: Gtk.TextMark | null = null;
  let dictEnd: Gtk.TextMark | null = null;
  /** marques posées au curseur ; espace devant si le texte précédent n'en finit pas par une */
  let dictSpace = false;
  /** transcription finale en cours : la fin de l'enregistrement n'est pas une annulation */
  let finishing = false;
  const openDictation = (): void => {
    const at = buffer.get_iter_at_mark(buffer.get_insert());
    const before = at.copy();
    dictSpace = before.backward_char() && !/\s/u.test(before.get_char());
    dictStart = buffer.create_mark(null, at, true);
    dictEnd = buffer.create_mark(null, at, false);
  };
  /** remplace le texte dicté ; `draft` : aperçu (italique grisé) */
  const setDictated = (text: string, draft: boolean): void => {
    if (dictStart === null || dictEnd === null) return;
    const start = buffer.get_iter_at_mark(dictStart);
    const end = buffer.get_iter_at_mark(dictEnd);
    programmatic = true;
    buffer.delete(start, end);
    const at = buffer.get_iter_at_mark(dictStart);
    const value = text === '' ? '' : `${dictSpace ? ' ' : ''}${text}`;
    buffer.insert(at, value, -1);
    if (draft) buffer.apply_tag(dictationTag, buffer.get_iter_at_mark(dictStart), buffer.get_iter_at_mark(dictEnd));
    programmatic = false;
  };
  const closeDictation = (): void => {
    if (dictEnd !== null) buffer.place_cursor(buffer.get_iter_at_mark(dictEnd));
    if (dictStart !== null) buffer.delete_mark(dictStart);
    if (dictEnd !== null) buffer.delete_mark(dictEnd);
    dictStart = null;
    dictEnd = null;
  };
  const unsubscribePartial = dictation.partial.subscribe(() => {
    if (dictating && dictation.state.peek() === 'recording') setDictated(dictation.partial.peek(), true);
  });
  // annulée (Échap, autre fenêtre) : aperçu retiré
  const unsubscribeState = dictation.state.subscribe(() => {
    if (dictating && !finishing && dictation.state.peek() === 'idle' && dictStart !== null) {
      setDictated('', false);
      closeDictation();
      dictating = false;
    }
  });
  onCleanup(() => {
    unsubscribePartial();
    unsubscribeState();
  });
  const startDictation = (): void => {
    if (dictation.state.peek() !== 'idle') return;
    try {
      openDictation();
      dictating = true;
      dictation.start(voiceSettings(), setVoiceStatus);
    } catch (e) {
      closeDictation();
      dictating = false;
      props.toast(`Dictée impossible : ${errorMessage(e)}`);
    }
  };
  const finishDictation = (): void => {
    if (!dictating || dictation.state.peek() !== 'recording') return;
    const v = voiceSettings();
    finishing = true;
    const go = async (): Promise<void> => {
      try {
        const text = await dictation.stop(v, setVoiceStatus);
        setDictated(text, false);
        closeDictation();
        if (text === '') props.toast('Dictée : rien n’a été compris');
        else if (v.autoSend) submit();
      } catch (e) {
        setDictated('', false);
        closeDictation();
        props.toast(`Dictée impossible : ${errorMessage(e)}`);
      } finally {
        dictating = false;
        finishing = false;
        setVoiceStatus('');
      }
    };
    void go();
  };
  const cancelDictation = (): boolean => {
    if (!dictating || dictation.state.peek() !== 'recording') return false;
    dictation.cancel();
    dictating = false;
    return true;
  };
  const toggleDictation = (): void => {
    if (dictation.state.peek() === 'idle') startDictation();
    else finishDictation();
  };
  onCleanup(() => {
    cancelDictation();
  });
  /** raccourci : appui bref = bascule, maintenu = parler tant qu'il est enfoncé */
  let keyDown = 0;
  let startedByKey = false;
  const dictationKeyPressed = (): void => {
    if (keyDown !== 0) return; // répétition automatique
    keyDown = GLib.get_monotonic_time();
    startedByKey = dictation.state.peek() === 'idle';
    toggleDictation();
  };
  const dictationKeyReleased = (): void => {
    if (keyDown === 0) return;
    const held = (GLib.get_monotonic_time() - keyDown) / 1000;
    keyDown = 0;
    if (startedByKey && held > HOLD_MS) finishDictation();
  };

  /** Complétion « / » et « @ », historique, suppression des mentions d'un bloc. */
  const setupTextView = (view: Gtk.TextView): void => {
    const popover = new CompletionPopover(view);
    const cursorIter = (): Gtk.TextIter => buffer.get_iter_at_mark(buffer.get_insert());
    /** remplace [start, end[ par `text` ; `tag` : mise en évidence comme mention */
    const replace = (start: number, end: number, text: string, tag: boolean): void => {
      programmatic = true;
      const a = buffer.get_iter_at_offset(start);
      const b = buffer.get_iter_at_offset(end);
      buffer.delete(a, b);
      const at = buffer.get_iter_at_offset(start);
      buffer.insert(at, text, -1);
      if (tag) buffer.apply_tag(mentionTag, buffer.get_iter_at_offset(start), buffer.get_iter_at_offset(start + GLib.utf8_strlen(text, -1)));
      programmatic = false;
    };

    let findCancel: Gio.Cancellable | null = null;
    let findTimer: number | null = null;
    let wasSlash = false;
    const stopFind = (): void => {
      if (findTimer !== null) GLib.source_remove(findTimer);
      findTimer = null;
      findCancel?.cancel();
      findCancel = null;
    };

    /** Recherche les fichiers de `query` et affiche la liste ; la mention remplacera [start, end[. */
    const searchFiles = async (query: string, cancellable: Gio.Cancellable, startOffset: number, endOffset: number): Promise<void> => {
      let paths: string[];
      try {
        paths = await props.findFiles(query, cancellable);
      } catch (e) {
        if (!cancellable.is_cancelled()) console.error(e);
        return;
      }
      if (cancellable.is_cancelled()) return;
      const items = paths.slice(0, FIND_LIMIT).map((path): CompletionItem => {
        const directory = path.endsWith('/');
        const trimmed = directory ? path.slice(0, -1) : path;
        const slashAt = trimmed.lastIndexOf('/');
        const name = trimmed.slice(slashAt + 1) + (directory ? '/' : '');
        const [type] = Gio.content_type_guess(name, null);
        return {
          title: name,
          subtitle: slashAt === -1 ? '' : trimmed.slice(0, slashAt + 1),
          icon: directory ? folderIcon : Gio.content_type_get_symbolic_icon(type),
          accept: () => {
            const mention = `@${path}`;
            mentioned.set(mention, directory);
            replace(startOffset, endOffset, mention, true);
            const after = startOffset + GLib.utf8_strlen(mention, -1);
            // un dossier poursuit la complétion dans son contenu, un fichier est suivi d'une espace
            if (!directory) replace(after, after, ' ', false);
            buffer.place_cursor(buffer.get_iter_at_offset(after + (directory ? 0 : 1)));
            if (directory) update();
          },
        };
      });
      popover.show(items, buffer.get_iter_at_offset(startOffset));
    };

    const update = (): void => {
      const cursor = cursorIter();
      const before = buffer.get_slice(buffer.get_start_iter(), cursor, true);
      // commande : texte commençant par « / », curseur dans le premier mot
      const slash = /^\/(\S*)$/u.exec(before);
      const command = commandOf(buffer.text.trim());
      setHint(command?.entry.hints === undefined ? HINT : `/${command.entry.name} ${command.entry.hints}`);
      if (slash !== null) {
        stopFind();
        if (!wasSlash) void loadCommands().then(update);
        wasSlash = true;
        const query = slash[1] ?? '';
        const wordEnd = cursor.copy();
        while (!wordEnd.is_end() && !/\s/u.test(wordEnd.get_char())) wordEnd.forward_char();
        const end = wordEnd.get_offset();
        const items = rank(commandEntries(), query, (c) => c.name).map((c): CompletionItem => ({
          title: `/${c.name}`,
          subtitle: c.description.split('\n')[0] ?? '',
          badge: c.badge,
          accept: () => {
            replace(0, end, `/${c.name} `, false);
            buffer.place_cursor(buffer.get_iter_at_offset(c.name.length + 2));
          },
        }));
        popover.show(items, buffer.get_start_iter());
        return;
      }
      wasSlash = false;
      // mention : mot sous le curseur commençant par « @ » (en début de texte ou après une espace)
      const at = /(?:^|\s)@(\S*)$/u.exec(before);
      if (at === null) {
        stopFind();
        popover.hide();
        return;
      }
      const query = at[1] ?? '';
      const startOffset = cursor.get_offset() - GLib.utf8_strlen(query, -1) - 1;
      const wordEnd = cursor.copy();
      while (!wordEnd.is_end() && !/\s/u.test(wordEnd.get_char())) wordEnd.forward_char();
      const endOffset = wordEnd.get_offset();
      stopFind();
      const cancellable = new Gio.Cancellable();
      findCancel = cancellable;
      findTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FIND_DELAY_MS, () => {
        findTimer = null;
        void searchFiles(query, cancellable, startOffset, endOffset);
        return GLib.SOURCE_REMOVE;
      });
    };

    // mise à jour regroupée (changement de texte + déplacement du curseur dans la même frappe)
    let queued = false;
    const schedule = (): void => {
      if (queued) return;
      queued = true;
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        queued = false;
        if (view.has_focus) update();
        return GLib.SOURCE_REMOVE;
      });
    };
    buffer.connect('changed', () => {
      if (!programmatic) historyIndex = null;
      schedule();
    });
    buffer.connect('notify::cursor-position', schedule);
    view.connect('destroy', stopFind);

    /** curseur sur la première / dernière ligne affichée */
    const onFirstLine = (): boolean => !view.backward_display_line(cursorIter());
    const onLastLine = (): boolean => !view.forward_display_line(cursorIter());
    const recall = (index: number | null): void => {
      historyIndex = index;
      setText(index === null ? '' : (historyList[index] ?? ''));
      popover.hide();
    };

    // phase de capture : avant les raccourcis de déplacement du TextView
    const keys = new Gtk.EventControllerKey({
      propagationPhase: Gtk.PropagationPhase.CAPTURE,
    });
    keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number, _code: number, state: Gdk.ModifierType) => {
      if (popover.key(keyval, state)) return true;
      const mods = state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.SHIFT_MASK | Gdk.ModifierType.ALT_MASK);
      if (mods !== 0) return false;
      switch (keyval) {
        case Gdk.KEY_Up:
        case Gdk.KEY_KP_Up:
          if (historyIndex === null) {
            if (buffer.text !== '') return false;
            historyList = historyEntries();
            if (historyList.length === 0) return false;
            recall(0);
            return true;
          }
          if (!onFirstLine()) return false;
          // premier prompt atteint : on s'arrête, sans boucler
          if (historyIndex + 1 < historyList.length) recall(historyIndex + 1);
          return true;
        case Gdk.KEY_Down:
        case Gdk.KEY_KP_Down:
          if (historyIndex === null || !onLastLine()) return false;
          recall(historyIndex === 0 ? null : historyIndex - 1);
          return true;
        case Gdk.KEY_Escape:
          if (historyIndex === null) return false;
          recall(null);
          return true;
        case Gdk.KEY_BackSpace: {
          // mention supprimée d'un bloc
          const [hasSelection] = buffer.get_selection_bounds();
          const cursor = cursorIter();
          if (hasSelection || !cursor.ends_tag(mentionTag)) return false;
          const range = mentionRanges().find((r) => r.end.equal(cursor));
          if (range === undefined) return false;
          buffer.delete(range.start, range.end);
          return true;
        }
        default:
          return false;
      }
    });
    view.add_controller(keys);
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
              if (ctrl && !shift && (keyval === Gdk.KEY_m || keyval === Gdk.KEY_M)) {
                dictationKeyPressed();
                return true;
              }
              if (enter && (SEND_WITH_CTRL ? ctrl : !shift && !ctrl)) {
                submit();
                return true;
              }
              return false;
            });
            keys.connect('key-released', (_c: Gtk.EventControllerKey, keyval: number) => {
              if (keyval === Gdk.KEY_m || keyval === Gdk.KEY_M || keyval === Gdk.KEY_Control_L || keyval === Gdk.KEY_Control_R) dictationKeyReleased();
            });
            self.add_controller(keys);
            setupTextView(self);
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
        {/* les menus passent à la ligne quand la fenêtre est étroite (pas de largeur minimale imposée) */}
        <Adw.WrapBox childSpacing={6} lineSpacing={6} hexpand valign={Gtk.Align.CENTER}>
          <Gtk.Button
            iconName="mail-attachment-symbolic"
            tooltipText="Joindre des fichiers ou des images (ou coller / glisser-déposer)"
            cssClasses={['flat', 'circular']}
            onClicked={(self: Gtk.Button) => attach(pickFiles(self))}
          />
          {agentDD}
          {modelDD}
          {variantDD}
          <ContextGauge context={props.context} limits={limits} />
          <Gtk.Label valign={Gtk.Align.CENTER} cssClasses={['dim-label', 'caption']} label={hint} visible={dictationLabel((l) => l === '')} />
          <Gtk.Label valign={Gtk.Align.CENTER} cssClasses={['caption']} label={dictationLabel} visible={dictationLabel((l) => l !== '')} />
        </Adw.WrapBox>
        <Gtk.Button
          iconName={dictation.state((st) => (st === 'transcribing' ? 'content-loading-symbolic' : 'audio-input-microphone-symbolic'))}
          valign={Gtk.Align.END}
          tooltipText={dictation.state((st) => (st === 'recording' ? `Terminer la dictée (${DICTATION_KEY})` : st === 'transcribing' ? 'Transcription…' : `Dicter (${DICTATION_KEY} : appui bref pour commencer et finir, ou maintenu pendant que vous parlez)`))}
          cssClasses={dictation.state((st) => (st === 'recording' ? ['circular', 'flat', 'dictating'] : ['circular', 'flat']))}
          sensitive={dictation.state((st) => st !== 'transcribing')}
          onClicked={toggleDictation}
        />
        <Gtk.Button
          iconName="media-playback-stop-symbolic"
          valign={Gtk.Align.END}
          tooltipText="Interrompre"
          cssClasses={['circular', 'destructive-action']}
          visible={props.busy}
          onClicked={() => {
            props.abort();
          }}
        />
        <Gtk.Button iconName="go-up-symbolic" valign={Gtk.Align.END} tooltipText={SEND_WITH_CTRL ? 'Envoyer (Ctrl+Entrée)' : 'Envoyer (Entrée)'} cssClasses={['circular', 'suggested-action']} onClicked={submit} />
      </Gtk.Box>
    </Gtk.Box>
  );
}
