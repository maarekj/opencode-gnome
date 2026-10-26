// Lecture à voix haute : Piper (local), speech-dispatcher ou API OpenAI, joué par pw-play ;
// texte découpé en morceaux, le suivant synthétisé pendant la lecture du précédent.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import { createState, type Accessor } from 'gnim';
import type { VoiceSettings } from './settings.ts';
import { chunks, piperVoicePath } from './speech.ts';
import { download, encoder, OPENAI, openaiKey, openaiRequest, remove, run, simulated, tempFile, tool, voiceDir } from './voice.ts';

/** Fichier de la voix Piper. */
export const piperModel = (voice: string): string => GLib.build_filenamev([voiceDir(), `${voice}.onnx`]);

/** Voix Piper téléchargée si besoin (modèle et configuration). */
export async function piperReady(voice: string, status: (msg: string) => void): Promise<void> {
  const rel = piperVoicePath(voice);
  if (rel === null) throw new Error(`voix Piper inconnue : ${voice}`);
  const model = piperModel(voice);
  const base = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${rel}`;
  await download(`${base}.onnx.json`, `${model}.json`, status, `de la voix ${voice}`);
  await download(`${base}.onnx`, model, status, `de la voix ${voice}`);
}

/** Synthèse d'un morceau de texte en fichier WAV. */
export async function synthesize(text: string, v: VoiceSettings, status: (msg: string) => void, cancellable: Gio.Cancellable): Promise<string> {
  const out = tempFile('.wav');
  if (v.tts === 'openai') {
    const msg = Soup.Message.new('POST', `${OPENAI}/audio/speech`);
    if (msg === null) throw new Error('URL invalide');
    msg.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(JSON.stringify({ model: 'gpt-4o-mini-tts', voice: v.openaiVoice, input: text, response_format: 'wav', speed: v.rate }))));
    const data = await openaiRequest(msg, openaiKey(v));
    GLib.file_set_contents(out, data);
    return out;
  }
  const piper = tool('piper', 'paquet piper-tts');
  await piperReady(v.piperVoice, status);
  const model = piperModel(v.piperVoice);
  await run([piper, '-m', model, '-c', `${model}.json`, '--length-scale', String(1 / Math.max(0.5, v.rate)), '-f', out], text, cancellable);
  return out;
}

/** Lecture à voix haute ; une seule à la fois (une nouvelle lecture arrête la précédente). */
export class Speaker {
  /** clé de ce qui est lu (partie de message), null : rien */
  readonly reading: Accessor<string | null>;
  readonly #setReading: (k: string | null) => void;
  #cancel: Gio.Cancellable | null = null;

  constructor() {
    [this.reading, this.#setReading] = createState<string | null>(null);
  }

  stop(): void {
    if (this.#cancel === null) return;
    this.#cancel.cancel();
    this.#cancel = null;
    this.#setReading(null);
    if (simulated()) console.log('LECTURE arrêt');
  }

  /** Lit `text` (déjà nettoyé) ; se termine à la fin de la lecture ou à l'arrêt. */
  async speak(key: string, text: string, v: VoiceSettings, status: (msg: string) => void = () => {}): Promise<void> {
    this.stop();
    const cancel = new Gio.Cancellable();
    this.#cancel = cancel;
    this.#setReading(key);
    try {
      if (simulated()) {
        console.log(`LECTURE ${text.replaceAll('\n', ' ')}`);
        await new Promise<void>((resolve) => {
          const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Number(GLib.getenv('OPENCODE_GNOME_TEST_SPEECH_MS') ?? 30_000), () => {
            resolve();
            return GLib.SOURCE_REMOVE;
          });
          cancel.connect(() => {
            GLib.source_remove(id);
            resolve();
          });
        });
        return;
      }
      if (v.tts === 'speechd') {
        const rate = Math.round(Math.max(-100, Math.min(100, (v.rate - 1) * 100)));
        cancel.connect(() => {
          void run([tool('spd-say', 'speech-dispatcher'), '-C']).catch(() => {});
        });
        await run([tool('spd-say', 'speech-dispatcher'), '-w', '-l', v.language, '-r', String(rate), text], null, cancel);
        return;
      }
      const play = tool('pw-play', 'PipeWire');
      // le morceau suivant est synthétisé pendant la lecture du précédent
      const parts = chunks(text, v.tts === 'openai' ? 2000 : 600);
      let next: Promise<string> | null = parts.length > 0 ? synthesize(parts[0] ?? '', v, status, cancel) : null;
      for (let i = 0; i < parts.length && next !== null; i++) {
        // oxlint-disable-next-line no-await-in-loop -- lecture morceau par morceau, dans l'ordre
        const wav = await next;
        if (cancel.is_cancelled()) {
          remove(wav);
          break;
        }
        status('');
        next = i + 1 < parts.length ? synthesize(parts[i + 1] ?? '', v, status, cancel) : null;
        try {
          // oxlint-disable-next-line no-await-in-loop -- lecture morceau par morceau, dans l'ordre
          await run([play, wav], null, cancel);
        } finally {
          remove(wav);
        }
      }
      if (next !== null) void next.then(remove, () => {});
    } catch (e) {
      if (!cancel.is_cancelled()) throw e;
    } finally {
      if (this.#cancel === cancel) {
        this.#cancel = null;
        this.#setReading(null);
      }
    }
  }
}

