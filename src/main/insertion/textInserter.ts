import { clipboard, app, systemPreferences } from 'electron';
import { execFileSync } from 'child_process';
import { getBinaryPath } from '../utils/swiftBinary';

/**
 * Run the `text-insert` Swift helper with one action. The helper posts
 * keystrokes via CGEvent (needs only Accessibility, no Automation) and reads
 * frontmost/modifiers via AppKit (no permission) — replacing the old osascript /
 * System Events path, which the dev binary can't use because it lacks an
 * Info.plist Automation usage string (mirrors `insert_helper` in
 * `text_inserter.rs`). Returns trimmed stdout on exit-0, else null.
 */
function insertHelper(args: string[]): string | null {
  try {
    return execFileSync(getBinaryPath('text-insert'), args, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/** True if the helper action (paste/replace/delete) exited 0. A non-zero exit
 * means Accessibility isn't granted to the helper. */
function insertHelperOk(args: string[]): boolean {
  try {
    execFileSync(getBinaryPath('text-insert'), args, { timeout: 10000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export class TextInserter {
  private lastInsertedText: string | null = null;
  /** The text we most recently wrote to the clipboard (restore guard). */
  private lastClipboardWrite: string | null = null;
  /** User clipboard captured before the first paste of a dictation session. */
  private savedClipboard: { text: string; html: string; rtf: string } | null = null;

  get lastInserted(): string | null {
    return this.lastInsertedText;
  }

  /**
   * Reads the frontmost process and the held modifier keys (via the AppKit-backed
   * `text-insert` helper), then performs only the expensive steps actually needed:
   * activating the target app (200ms settle) and waiting for modifier release.
   * In the common case (target already focused, hotkey long released) this
   * replaces ~530ms of fixed sleeps with a single ~60ms check.
   */
  private async prepareForPaste(targetApp?: string | null): Promise<void> {
    const frontmost = insertHelper(['frontmost']) || null;
    const modRaw = insertHelper(['modifiers']);
    let modifiers = modRaw !== null ? parseInt(modRaw, 10) : -1;
    if (Number.isNaN(modifiers)) modifiers = -1;

    if (targetApp && frontmost !== targetApp) {
      this.activateApp(targetApp);
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    if (modifiers === 0) return; // keys already released — paste immediately
    if (modifiers < 0) {
      // Couldn't read modifier state — keep the old conservative fixed delay.
      await new Promise(resolve => setTimeout(resolve, 300));
      return;
    }
    // Modifiers still held (hotkey release in flight) — poll briefly.
    const deadline = Date.now() + 600;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (insertHelper(['modifiers']) === '0') return;
    }
  }

  private activateApp(targetApp: string): void {
    // NSWorkspace activation by name — needs no permission (mirrors
    // `activate_app` in text_inserter.rs).
    insertHelper(['activate', targetApp]);
  }

  /** Bring the target app forward only when it isn't already frontmost. */
  private async ensureAppFocus(targetApp: string): Promise<void> {
    if ((insertHelper(['frontmost']) || null) === targetApp) return;
    this.activateApp(targetApp);
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  /** Capture the user's clipboard once per dictation session (before we touch it). */
  private snapshotClipboardOnce(): void {
    if (this.savedClipboard !== null) return;
    this.savedClipboard = {
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      rtf: clipboard.readRTF(),
    };
  }

  /**
   * Restore the clipboard captured at the start of the session. Safe to call
   * from every pipeline exit path — it no-ops when there is nothing to restore,
   * and never clobbers a copy the user made mid-dictation.
   */
  async restoreUserClipboard(): Promise<void> {
    const saved = this.savedClipboard;
    this.savedClipboard = null;
    if (!saved) return;
    // Allow the last paste to complete before we swap the clipboard back.
    await new Promise(resolve => setTimeout(resolve, 150));
    if (this.lastClipboardWrite !== null && clipboard.readText() === this.lastClipboardWrite) {
      if (saved.html || saved.rtf) {
        clipboard.write({
          text: saved.text,
          html: saved.html || undefined,
          rtf: saved.rtf || undefined,
        });
      } else {
        clipboard.writeText(saved.text);
      }
      console.log('[inserter] Clipboard restored');
    } else {
      console.log('[inserter] Clipboard changed externally, skipping restore');
    }
  }

  /**
   * Insert text via clipboard paste (Cmd+V).
   * Skips the activate/modifier waits when they aren't needed, and restores the
   * user's clipboard afterwards (session-aware: if live text was injected
   * earlier, the clipboard from *before* the first injection is restored).
   */
  async insert(text: string, targetApp?: string | null): Promise<void> {
    try {
      await this.prepareForPaste(targetApp);

      this.snapshotClipboardOnce();
      clipboard.writeText(text);
      this.lastClipboardWrite = text;

      // Small delay post-release + clipboard write
      await new Promise(resolve => setTimeout(resolve, 30));

      if (!insertHelperOk(['paste'])) {
        throw new Error('paste keystroke failed');
      }

      this.lastInsertedText = text;
      console.log(`[inserter] Pasted ${text.length} chars into ${targetApp ?? 'focused app'}`);

      await this.restoreUserClipboard();
    } catch (err) {
      throw new Error(`Text insertion failed: ${(err as Error).message}. Check Accessibility permissions.`);
    }
  }

  /**
   * Lightweight insert for live streaming — pastes without waiting on modifier
   * release. Returns whether the paste actually happened so callers only track
   * text that is really on screen (a phantom count would make the later
   * replace step delete the user's own text).
   *
   * Pass `targetApp` to re-focus the source app first (used by the pipeline's
   * instant insert, where the user may have switched apps since recording).
   * The live-streaming path omits it — focus hasn't moved mid-recording, and
   * per-chunk activation would steal focus.
   */
  async insertLive(text: string, targetApp?: string | null): Promise<boolean> {
    if (!text) return false;
    try {
      if (targetApp) {
        await this.ensureAppFocus(targetApp);
      }
      this.snapshotClipboardOnce();
      clipboard.writeText(text);
      this.lastClipboardWrite = text;
      await new Promise(resolve => setTimeout(resolve, 20));
      if (!insertHelperOk(['paste'])) {
        console.warn('[inserter] Live insert paste failed');
        return false;
      }
      this.lastInsertedText = text;
      return true;
    } catch (err) {
      console.warn('[inserter] Live insert failed:', (err as Error).message);
      return false;
    }
  }

  /**
   * Replace live-injected text with refined text.
   * Selects back over the live-injected characters, then pastes the replacement.
   * An empty `refinedText` deletes the selection with a real Delete keypress —
   * pasting an empty clipboard can no-op in some apps and leave text selected.
   */
  async replaceLiveText(refinedText: string, liveCharCount: number, targetApp?: string | null): Promise<void> {
    if (liveCharCount <= 0 && !refinedText) return;
    try {
      await this.prepareForPaste(targetApp);

      if (!refinedText) {
        // Select back over the live chars and delete them in one helper call.
        insertHelperOk(['delete', String(liveCharCount)]);
        this.lastInsertedText = null;
        console.log(`[inserter] Deleted ${liveCharCount} live chars`);
        return;
      }

      this.snapshotClipboardOnce();
      clipboard.writeText(refinedText);
      this.lastClipboardWrite = refinedText;
      await new Promise(resolve => setTimeout(resolve, 30));

      // Select back over the live chars, then paste the replacement.
      if (!insertHelperOk(['replace', String(liveCharCount)])) {
        throw new Error('replace keystroke failed');
      }
      this.lastInsertedText = refinedText;
      console.log(`[inserter] Replaced ${liveCharCount} chars with ${refinedText.length} refined chars`);
    } catch (err) {
      console.warn('[inserter] Replace failed, falling back to append:', (err as Error).message);
      if (refinedText) {
        await this.insert(refinedText, targetApp);
      }
    }
  }

  /**
   * Undo the last insertion: select back over the inserted characters and
   * delete them, using the same proven select path as the EMPTY-sentinel
   * cleanup. Count graphemes via Array.from so emoji and combining marks
   * select correctly. Never touches the clipboard.
   */
  async undoLastInsertion(text: string, targetApp?: string | null): Promise<void> {
    const count = Array.from(text).length;
    if (count === 0) return;
    await this.replaceLiveText('', count, targetApp);
    this.lastInsertedText = null;
  }

  static checkPermissions(): { ok: boolean; message: string } {
    // Packaged build: the app is a single "Echo" TCC identity, so ask the OS
    // about THIS process. Spawning the `text-insert` helper instead evaluates
    // the helper as its own AX subject, which reads "not granted" even when the
    // "Echo" row the user toggled in System Settings is on (mirrors the
    // is_packaged() branch of get_status in src-tauri/src/lib.rs). Dev keeps the
    // helper check: there the helper disclaims to its own identity, and that
    // grant is what actually gates insertion.
    const granted = app.isPackaged
      ? systemPreferences.isTrustedAccessibilityClient(false)
      : insertHelper(['check-ax']) === 'ax-granted';
    if (granted) {
      return { ok: true, message: 'Accessibility permissions granted' };
    }
    return {
      ok: false,
      message: 'Accessibility permission required. Go to System Settings > Privacy & Security > Accessibility and add Echo.',
    };
  }

  /** Prompt for Accessibility once and register the `text-insert` helper in the
   * System Settings list so the user can grant it. Call at startup after
   * ensuring the binary exists. Returns true if already trusted. */
  static ensureAccessibility(): boolean {
    return insertHelper(['ensure-ax']) === 'ax-granted';
  }
}
