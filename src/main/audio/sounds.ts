import { execFile } from 'child_process';

/**
 * Plays a macOS system sound. Non-blocking, fire-and-forget.
 * Sound names: Tink, Pop, Basso, Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Purr, Sosumi, Submarine
 */
function playSystemSound(name: string): void {
  const soundPath = `/System/Library/Sounds/${name}.aiff`;
  execFile('afplay', [soundPath], (err) => {
    if (err) console.warn(`[sounds] Failed to play ${name}:`, err.message);
  });
}

export function playRecordingStart(): void {
  playSystemSound('Tink');
}

export function playRecordingStop(): void {
  playSystemSound('Pop');
}

export function playError(): void {
  playSystemSound('Basso');
}

export function playSuccess(): void {
  playSystemSound('Glass');
}
