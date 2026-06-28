import { clipboard } from 'electron';
import { execSync, execFileSync } from 'child_process';

export class TextInserter {
  private lastInsertedText: string | null = null;

  get lastInserted(): string | null {
    return this.lastInsertedText;
  }

  /**
   * Activate the target app so it has focus for paste.
   */
  private async activateApp(targetApp: string): Promise<void> {
    execFileSync('osascript', ['-e', `tell application "${targetApp}" to activate`], { timeout: 2000 });
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  /**
   * Wait until all modifier keys (Cmd, Shift, Ctrl, Option) are released.
   * Polls every 25ms, gives up after 600ms. This prevents the paste Cmd+V
   * from being confused by still-held modifier keys from the hotkey.
   */
  private async waitForModifierRelease(): Promise<void> {
    // Simple fixed delay — more reliable than polling AppleScript modifier state
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  /**
   * Insert text via clipboard paste (Cmd+V).
   * Waits for modifier keys to be released, preserves and restores clipboard.
   */
  async insert(text: string, targetApp?: string | null): Promise<void> {
    try {
      if (targetApp) {
        await this.activateApp(targetApp);
      }

      // Wait for hotkey modifiers to be released before pasting
      await this.waitForModifierRelease();

      // Preserve current clipboard
      const previousClipboard = clipboard.readText();
      const previousHtml = clipboard.readHTML();
      const previousRtf = clipboard.readRTF();

      // Write our text to clipboard
      clipboard.writeText(text);

      // Small delay post-release + clipboard write
      await new Promise(resolve => setTimeout(resolve, 30));

      // Simulate Cmd+V paste via AppleScript
      execFileSync('osascript', ['-e',
        'tell application "System Events" to keystroke "v" using {command down}',
      ], { timeout: 5000 });

      this.lastInsertedText = text;
      console.log(`[inserter] Pasted ${text.length} chars into ${targetApp ?? 'focused app'}`);

      // Restore clipboard after a short delay (allow paste to complete)
      await new Promise(resolve => setTimeout(resolve, 150));

      // Only restore if clipboard hasn't changed (another app might have written to it)
      if (clipboard.readText() === text) {
        if (previousHtml || previousRtf) {
          clipboard.write({
            text: previousClipboard,
            html: previousHtml || undefined,
            rtf: previousRtf || undefined,
          });
        } else {
          clipboard.writeText(previousClipboard);
        }
        console.log('[inserter] Clipboard restored');
      } else {
        console.log('[inserter] Clipboard changed externally, skipping restore');
      }
    } catch (err) {
      throw new Error(`Text insertion failed: ${(err as Error).message}. Check Accessibility permissions.`);
    }
  }

  /**
   * Lightweight insert for live streaming — types text without clipboard save/restore.
   * Used during live transcription to inject words as they arrive.
   */
  async insertLive(text: string): Promise<void> {
    if (!text) return;
    try {
      clipboard.writeText(text);
      await new Promise(resolve => setTimeout(resolve, 20));
      execFileSync('osascript', ['-e',
        'tell application "System Events" to keystroke "v" using {command down}',
      ], { timeout: 3000 });
      this.lastInsertedText = text;
    } catch (err) {
      console.warn('[inserter] Live insert failed:', (err as Error).message);
    }
  }

  /**
   * Replace live-injected text with refined text.
   * Selects back over the live-injected characters, then pastes the replacement.
   */
  async replaceLiveText(refinedText: string, liveCharCount: number, targetApp?: string | null): Promise<void> {
    try {
      if (targetApp) {
        await this.activateApp(targetApp);
      }
      await this.waitForModifierRelease();

      // Select the live-injected text by pressing Shift+Left arrow for each character
      // Use AppleScript to send backspace keys to delete the live text
      const deleteScript = `
        tell application "System Events"
          repeat ${liveCharCount} times
            key code 123 using {shift down}
          end repeat
          keystroke "v" using {command down}
        end tell
      `;

      const previousClipboard = clipboard.readText();
      clipboard.writeText(refinedText);
      await new Promise(resolve => setTimeout(resolve, 30));

      execFileSync('osascript', ['-e', deleteScript], { timeout: 10000 });
      this.lastInsertedText = refinedText;
      console.log(`[inserter] Replaced ${liveCharCount} chars with ${refinedText.length} refined chars`);

      await new Promise(resolve => setTimeout(resolve, 150));
      if (clipboard.readText() === refinedText) {
        clipboard.writeText(previousClipboard);
      }
    } catch (err) {
      console.warn('[inserter] Replace failed, falling back to append:', (err as Error).message);
      await this.insert(refinedText, targetApp);
    }
  }

  static checkPermissions(): { ok: boolean; message: string } {
    try {
      execSync(
        `osascript -e 'tell application "System Events" to get name of first process'`,
        { timeout: 5000, stdio: 'pipe' }
      );
      return { ok: true, message: 'Accessibility permissions granted' };
    } catch {
      return {
        ok: false,
        message: 'Accessibility permission required. Go to System Settings > Privacy & Security > Accessibility and add Echo.',
      };
    }
  }
}
