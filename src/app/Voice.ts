// Voix dans l'application : dictée et lecture partagées par toutes les conversations (un seul
// micro, une seule lecture à la fois), bouton « Lire » des messages, Échap pour arrêter.
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import type { Accessor } from 'gnim';
import type { Settings, VoiceSettings } from '../shared/settings.ts';
import { speakable } from '../shared/speech.ts';
import { Speaker } from '../shared/speaker.ts';
import { Dictation, voiceError } from '../shared/voice.ts';

export const dictation = new Dictation();
export const speaker = new Speaker();

let settings: Settings | null = null;
let notify: (message: string) => void = (m) => {
  console.error(m);
};

/** Réglages et affichage des messages (appelé au démarrage, puis par la fenêtre principale). */
export function initVoice(s: Settings, toast?: (message: string) => void): void {
  settings = s;
  if (toast !== undefined) notify = toast;
}

export const voiceSettings = (): VoiceSettings => {
  if (settings === null) throw new Error('voix non initialisée');
  return settings.data.peek().voice;
};

let readCounter = 0;

/** Lit (ou arrête de lire) le markdown `source` ; `key` identifie ce qui est lu. */
export function toggleRead(key: string, source: string): void {
  if (speaker.reading.peek() === key) {
    speaker.stop();
    return;
  }
  const text = speakable(source);
  if (text === '') return;
  speaker
    .speak(key, text, voiceSettings(), (msg) => {
      if (msg !== '') notify(msg);
    })
    .catch((e: unknown) => {
      notify(`Lecture impossible : ${voiceError(e)}`);
    });
}

/**
 * Bouton « Lire à voix haute » / « Arrêter la lecture » d'un texte markdown (`source` lu au clic).
 */
export function ReadButton(source: () => string, label = 'Lire à voix haute', cssClasses: string[] = ['flat', 'circular']): Gtk.Button {
  const key = `lecture-${++readCounter}`;
  const reading: Accessor<boolean> = speaker.reading((k) => k === key);
  const button = new Gtk.Button({ iconName: 'audio-speakers-symbolic', tooltipText: label, cssClasses });
  const sync = (): void => {
    const on = reading.peek();
    button.iconName = on ? 'media-playback-stop-symbolic' : 'audio-speakers-symbolic';
    button.tooltipText = on ? 'Arrêter la lecture (Échap)' : label;
    if (on) button.add_css_class('reading');
    else button.remove_css_class('reading');
  };
  const unsubscribe = reading.subscribe(sync);
  button.connect('destroy', unsubscribe);
  button.connect('clicked', () => {
    toggleRead(key, source());
  });
  return button;
}

/** Échap annule la dictée ou arrête la lecture en cours (avant les autres usages d'Échap de la fenêtre). */
export function escapeStopsVoice(window: Gtk.Window): void {
  const keys = new Gtk.EventControllerKey({ propagationPhase: Gtk.PropagationPhase.CAPTURE });
  keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number) => {
    if (keyval !== Gdk.KEY_Escape) return false;
    if (dictation.state.peek() === 'recording') {
      dictation.cancel();
      return true;
    }
    if (speaker.reading.peek() === null) return false;
    speaker.stop();
    return true;
  });
  window.add_controller(keys);
}

/** « 0:07 » */
export const fmtElapsed = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Supprime les fichiers temporaires restés d'une session précédente. */
export function cleanVoiceTemp(): void {
  const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'opencode-gnome-voice']);
  try {
    const d = GLib.Dir.open(dir, 0);
    for (let name = d.read_name(); name !== null; name = d.read_name()) GLib.unlink(GLib.build_filenamev([dir, name]));
    d.close();
  } catch {
    // dossier absent
  }
}
