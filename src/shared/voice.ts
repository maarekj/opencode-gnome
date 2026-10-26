// Voix : dictée (micro -> texte) et outils communs à la lecture (src/shared/speaker.ts).
// Moteurs : whisper.cpp (local) ou API OpenAI pour la dictée ; Piper (local), speech-dispatcher
// ou API OpenAI pour la lecture. Micro et lecture via PipeWire (pw-record / pw-play). Modèles
// locaux téléchargés au premier usage dans ~/.local/share/opencode-gnome/voice.
// En bac à sable (tests, captures) : moteurs simulés, journalisés (DICTEE / LECTURE).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import { createState, type Accessor } from 'gnim';
import { errorMessage } from './errors.ts';
import { wavFile } from './speech.ts';
import { sandboxed } from './sandbox.ts';
import type { VoiceSettings } from './settings.ts';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async', 'wait_finish');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Soup.Session.prototype, 'send_async', 'send_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async', 'write_bytes_finish');

export const OPENAI = 'https://api.openai.com/v1';
const decoder = new TextDecoder();
export const encoder = new TextEncoder();

export const WHISPER_MODELS: readonly { id: VoiceSettings['whisperModel']; label: string }[] = [
  { id: 'base', label: 'base · 150 Mo' },
  { id: 'small', label: 'small · 490 Mo' },
  { id: 'medium', label: 'medium · 1,5 Go' },
  { id: 'large-v3-turbo', label: 'large-v3-turbo · 1,6 Go' },
];
export const PIPER_VOICES: readonly string[] = ['fr_FR-siwis-medium', 'fr_FR-upmc-medium', 'fr_FR-tom-medium', 'fr_FR-gilles-low', 'en_US-lessac-medium', 'en_GB-alan-medium'];
export const OPENAI_VOICES: readonly string[] = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];

/** Simulation (tests, captures) : ni micro, ni haut-parleurs, ni réseau. */
export const simulated = (): boolean => sandboxed();

/** Dossier des modèles (partagé par toutes les versions installées). */
export const voiceDir = (): string => GLib.build_filenamev([GLib.get_user_data_dir(), 'opencode-gnome', 'voice']);

/** Programme : dossiers d'outils du lanceur (paquets Nix de l'app), puis PATH. */
export function findTool(name: string): string | null {
  for (const dir of (GLib.getenv('OPENCODE_GNOME_TOOLS_PATH') ?? '').split(':')) {
    if (dir === '') continue;
    const p = GLib.build_filenamev([dir, name]);
    if (GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) return p;
  }
  return GLib.find_program_in_path(name);
}

export function tool(name: string, hint: string): string {
  const p = findTool(name);
  if (p === null) throw new Error(`${name} introuvable (${hint})`);
  return p;
}

/** Fichier temporaire (supprimé par l'appelant). */
export function tempFile(suffix: string): string {
  const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'opencode-gnome-voice']);
  GLib.mkdir_with_parents(dir, 0o700);
  return GLib.build_filenamev([dir, `${GLib.uuid_string_random()}${suffix}`]);
}

export const remove = (path: string): void => {
  GLib.unlink(path);
};

export async function run(argv: string[], input: string | null = null, cancellable: Gio.Cancellable | null = null): Promise<string> {
  const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE | (input === null ? Gio.SubprocessFlags.NONE : Gio.SubprocessFlags.STDIN_PIPE));
  const id = cancellable?.connect(() => proc.force_exit()) ?? 0;
  try {
    const [out, err] = await proc.communicate_utf8_async(input, null);
    if (cancellable?.is_cancelled() === true) throw new Error('annulé');
    if (!proc.get_successful()) throw new Error(`${GLib.path_get_basename(argv[0] ?? '')} : ${(err ?? '').trim().split('\n').slice(-3).join(' ') || `code ${proc.get_exit_status()}`}`);
    return out ?? '';
  } finally {
    if (id !== 0) cancellable?.disconnect(id);
  }
}

// ------------------------------------------------------------------ réseau

const session = new Soup.Session({ timeout: 0, idleTimeout: 60 });

/** Avancement d'un téléchargement (octets reçus, taille totale si connue). */
export interface DownloadProgress {
  readonly received: number;
  readonly total: number | null;
}

const [downloadsState, setDownloads] = createState<ReadonlyMap<string, DownloadProgress>>(new Map());
/** téléchargements en cours, par fichier de destination */
export const downloads: Accessor<ReadonlyMap<string, DownloadProgress>> = downloadsState;
const inflight = new Map<string, Promise<void>>();

const setProgress = (dest: string, p: DownloadProgress | null): void => {
  const next = new Map(downloadsState.peek());
  if (p === null) next.delete(dest);
  else next.set(dest, p);
  setDownloads(next);
};

/**
 * Télécharge `url` vers `dest` (fichier partiel renommé à la fin) ; ne fait rien s'il existe.
 * Un même fichier n'est téléchargé qu'une fois à la fois (préférences et dictée attendent le même).
 */
export function download(url: string, dest: string, status: (msg: string) => void, label: string): Promise<void> {
  if (GLib.file_test(dest, GLib.FileTest.EXISTS)) return Promise.resolve();
  const running = inflight.get(dest);
  status(`Téléchargement ${label}…`);
  if (running !== undefined) return running;
  const job = (simulated() ? simulateDownload(dest) : fetchTo(url, dest, label)).finally(() => {
    inflight.delete(dest);
    setProgress(dest, null);
  });
  inflight.set(dest, job);
  return job;
}

/** Bac à sable : avancement simulé (3 s), rien n'est écrit. */
function simulateDownload(dest: string): Promise<void> {
  console.log(`TELECHARGEMENT ${GLib.path_get_basename(dest)}`);
  const total = 1_000_000;
  let received = 0;
  return new Promise((resolve) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
      received += total / 10;
      setProgress(dest, { received, total });
      if (received < total) return GLib.SOURCE_CONTINUE;
      resolve();
      return GLib.SOURCE_REMOVE;
    });
  });
}

async function fetchTo(url: string, dest: string, label: string): Promise<void> {
  GLib.mkdir_with_parents(GLib.path_get_dirname(dest), 0o755);
  setProgress(dest, { received: 0, total: null });
  const msg = Soup.Message.new('GET', url);
  if (msg === null) throw new Error(`URL invalide : ${url}`);
  const input = await session.send_async(msg, GLib.PRIORITY_DEFAULT, null);
  const code: number = msg.get_status();
  if (code < 200 || code >= 300) throw new Error(`téléchargement ${label} : HTTP ${code}`);
  const length = msg.get_response_headers().get_content_length();
  const total = length > 0 ? length : null;
  const part = Gio.File.new_for_path(`${dest}.part`);
  const out = part.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
  let received = 0;
  let shown = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- lecture du flux morceau par morceau
      const bytes = await input.read_bytes_async(1 << 20, GLib.PRIORITY_DEFAULT, null);
      const size = bytes.get_size();
      if (size === 0) break;
      // oxlint-disable-next-line no-await-in-loop -- écrit dans l'ordre
      await out.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, null);
      received += size;
      const now = GLib.get_monotonic_time();
      // au plus 5 mises à jour par seconde
      if (now - shown > 200_000) {
        shown = now;
        setProgress(dest, { received, total });
      }
    }
  } finally {
    out.close(null);
    input.close(null);
  }
  if (total !== null && received < total) throw new Error(`téléchargement ${label} interrompu`);
  part.move(Gio.File.new_for_path(dest), Gio.FileCopyFlags.OVERWRITE, null, null);
}

export function openaiKey(v: VoiceSettings): string {
  const key = v.openaiKey ?? GLib.getenv('OPENAI_API_KEY') ?? '';
  if (key === '') throw new Error('clé API OpenAI manquante (Préférences, Voix)');
  return key;
}

export async function openaiRequest(msg: Soup.Message, key: string): Promise<Uint8Array> {
  msg.get_request_headers().replace('Authorization', `Bearer ${key}`);
  const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
  const data = bytes.get_data() ?? new Uint8Array();
  const code: number = msg.get_status();
  if (code < 200 || code >= 300) {
    let detail = decoder.decode(data).slice(0, 200);
    try {
      const parsed: unknown = JSON.parse(decoder.decode(data));
      if (typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof parsed.error === 'object' && parsed.error !== null && 'message' in parsed.error) detail = String(parsed.error.message);
    } catch {
      // réponse non JSON : texte brut
    }
    throw new Error(`OpenAI : HTTP ${code} ${detail}`);
  }
  return data;
}

// ------------------------------------------------------------------ dictée

/** Fichier du modèle whisper choisi. */
export const whisperModel = (v: Pick<VoiceSettings, 'whisperModel'>): string => GLib.build_filenamev([voiceDir(), `ggml-${v.whisperModel}.bin`]);

/** Modèle whisper téléchargé si besoin. */
export const whisperReady = (v: Pick<VoiceSettings, 'whisperModel'>, status: (msg: string) => void): Promise<void> =>
  download(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${v.whisperModel}.bin`, whisperModel(v), status, `du modèle whisper ${v.whisperModel}`);

/** Transcription locale ; `draft` : recherche gloutonne, plus rapide (aperçu pendant la dictée). */
export async function transcribeWhisper(wav: string, v: VoiceSettings, status: (msg: string) => void, draft = false, cancellable: Gio.Cancellable | null = null): Promise<string> {
  const cli = tool('whisper-cli', 'paquet whisper-cpp');
  await whisperReady(v, status);
  if (!draft) status('Transcription…');
  const fast = draft ? ['-bs', '1', '-bo', '1', '-nf'] : [];
  const out = await run([cli, '-m', whisperModel(v), '-l', v.language, '-nt', '-np', ...fast, '-t', String(Math.min(8, GLib.get_num_processors())), '-f', wav], null, cancellable);
  return out.replaceAll(/\[[^\]]*\]/gu, ' ').replaceAll(/\s+/gu, ' ').trim();
}

async function transcribeOpenai(wav: string, v: VoiceSettings, status: (msg: string) => void): Promise<string> {
  const key = openaiKey(v);
  status('Transcription (OpenAI)…');
  const [, bytes] = GLib.file_get_contents(wav);
  const form = Soup.Multipart.new('multipart/form-data');
  form.append_form_string('model', 'gpt-4o-mini-transcribe');
  form.append_form_string('language', v.language);
  form.append_form_string('response_format', 'text');
  form.append_form_file('file', 'dictee.wav', 'audio/wav', new GLib.Bytes(bytes));
  const msg = Soup.Message.new_from_multipart(`${OPENAI}/audio/transcriptions`, form);
  return decoder.decode(await openaiRequest(msg, key)).trim();
}

export type DictationState = 'idle' | 'recording' | 'transcribing';

/** intervalle minimal entre deux aperçus (ms) */
const PREVIEW_MS = 800;

/**
 * Dictée : `start()` ouvre le micro, `stop()` le ferme et renvoie le texte transcrit (vide si
 * rien n'a été dit). Avec whisper, `partial` donne un aperçu pendant l'enregistrement (audio
 * retranscrit depuis le début, en recherche gloutonne, dès que le précédent aperçu est fini).
 * Une seule dictée à la fois dans l'application.
 */
export class Dictation {
  readonly state: Accessor<DictationState>;
  readonly #setState: (s: DictationState) => void;
  /** secondes d'enregistrement */
  readonly elapsed: Accessor<number>;
  readonly #setElapsed: (n: number) => void;
  /** aperçu de la transcription pendant l'enregistrement */
  readonly partial: Accessor<string>;
  readonly #setPartial: (s: string) => void;
  #proc: Gio.Subprocess | null = null;
  /** échantillons bruts (s16, 16 kHz, mono) écrits au fil de l'eau par pw-record */
  #raw = '';
  #timer = 0;
  #since = 0;
  #preview: Gio.Cancellable | null = null;
  #previewing = false;
  #lastPreview = 0;
  #previewBytes = 0;

  constructor() {
    [this.state, this.#setState] = createState<DictationState>('idle');
    [this.elapsed, this.#setElapsed] = createState(0);
    [this.partial, this.#setPartial] = createState('');
  }

  start(v: VoiceSettings, status: (msg: string) => void = () => {}): void {
    if (this.state.peek() !== 'idle') return;
    this.#setPartial('');
    this.#previewBytes = 0;
    this.#lastPreview = 0;
    if (simulated()) console.log('DICTEE début');
    else {
      this.#raw = tempFile('.raw');
      this.#proc = Gio.Subprocess.new([tool('pw-record', 'PipeWire'), '--raw', '--rate', '16000', '--channels', '1', '--format', 's16', this.#raw], Gio.SubprocessFlags.STDERR_SILENCE);
    }
    const preview = v.stt === 'whisper' && (simulated() || findTool('whisper-cli') !== null);
    if (preview) {
      this.#preview = new Gio.Cancellable();
      // modèle téléchargé pendant que l'on parle
      if (!simulated()) whisperReady(v, status).catch(() => {});
    }
    this.#since = GLib.get_monotonic_time();
    this.#setElapsed(0);
    this.#timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
      this.#setElapsed(Math.floor((GLib.get_monotonic_time() - this.#since) / 1e6));
      if (preview) this.#tick(v);
      return GLib.SOURCE_CONTINUE;
    });
    this.#setState('recording');
  }

  /** Lance un aperçu si le précédent est fini et que l'audio a avancé. */
  #tick(v: VoiceSettings): void {
    const now = GLib.get_monotonic_time() / 1000;
    if (this.#previewing || now - this.#lastPreview < PREVIEW_MS || this.#preview === null) return;
    const cancel = this.#preview;
    if (simulated()) {
      if (this.#previewBytes > 0) return;
      this.#previewBytes = 1;
      const text = GLib.getenv('OPENCODE_GNOME_TEST_DICTATION') ?? 'Texte dicté au micro';
      this.#setPartial(text.split(' ').slice(0, 2).join(' '));
      console.log('DICTEE aperçu');
      return;
    }
    if (!GLib.file_test(whisperModel(v), GLib.FileTest.EXISTS)) return;
    let pcm: Uint8Array;
    try {
      pcm = GLib.file_get_contents(this.#raw)[1];
    } catch {
      return;
    }
    // au moins 0,5 s d'audio nouveau
    if (pcm.length - this.#previewBytes < 16000) return;
    pcm = pcm.slice(0, pcm.length - (pcm.length % 2));
    this.#previewBytes = pcm.length;
    this.#previewing = true;
    const wav = tempFile('.wav');
    GLib.file_set_contents(wav, wavFile(pcm));
    transcribeWhisper(wav, v, () => {}, true, cancel)
      .then((text) => {
        if (!cancel.is_cancelled() && this.state.peek() === 'recording') this.#setPartial(text);
        return text;
      })
      .catch(() => '')
      .finally(() => {
        remove(wav);
        this.#previewing = false;
        this.#lastPreview = GLib.get_monotonic_time() / 1000;
      });
  }

  #stopRecording(): void {
    if (this.#timer !== 0) GLib.source_remove(this.#timer);
    this.#timer = 0;
    this.#preview?.cancel();
    this.#preview = null;
  }

  /** Abandonne l'enregistrement en cours (rien n'est transcrit). */
  cancel(): void {
    if (this.state.peek() !== 'recording') return;
    this.#stopRecording();
    this.#proc?.force_exit();
    this.#proc = null;
    if (this.#raw !== '') remove(this.#raw);
    this.#raw = '';
    this.#setPartial('');
    if (simulated()) console.log('DICTEE annulée');
    this.#setState('idle');
  }

  async stop(v: VoiceSettings, status: (msg: string) => void = () => {}): Promise<string> {
    if (this.state.peek() !== 'recording') return '';
    this.#stopRecording();
    this.#setState('transcribing');
    const wav = simulated() ? '' : tempFile('.wav');
    try {
      if (simulated()) {
        console.log('DICTEE fin');
        return GLib.getenv('OPENCODE_GNOME_TEST_DICTATION') ?? 'Texte dicté au micro';
      }
      const proc = this.#proc;
      this.#proc = null;
      if (proc !== null) {
        proc.send_signal(2);
        await proc.wait_async(null);
      }
      const pcm = GLib.file_get_contents(this.#raw)[1];
      GLib.file_set_contents(wav, wavFile(pcm.slice(0, pcm.length - (pcm.length % 2))));
      return v.stt === 'openai' ? await transcribeOpenai(wav, v, status) : await transcribeWhisper(wav, v, status);
    } finally {
      if (wav !== '') remove(wav);
      if (this.#raw !== '') remove(this.#raw);
      this.#raw = '';
      this.#setPartial('');
      this.#setState('idle');
    }
  }
}

/** Message d'erreur lisible (notification). */
export const voiceError = (e: unknown): string => errorMessage(e);
