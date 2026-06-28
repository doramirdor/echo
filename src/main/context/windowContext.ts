import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getBinaryPath } from '../utils/swiftBinary';

export interface WindowContext {
  appName: string;
  windowTitle: string;
  bundleId: string;
  selectedText: string;
  existingFieldText: string;
  screenshotPath?: string;
}

/** Text surrounding the caret in the focused field, for sentence continuation. */
export interface FieldContext {
  before: string;   // text before the insertion point
  after: string;    // text after the insertion point
  selected: string; // currently-selected text (to be replaced), if any
}

/**
 * Reads the focused field's text split at the caret via the `field-context`
 * Swift helper (Accessibility API). This is what powers mid-sentence
 * continuation — knowing what's immediately before/after the cursor. Resolves
 * to empty strings if AX info isn't available (no permission, unsupported app).
 */
export function captureFieldContext(): Promise<FieldContext> {
  const empty: FieldContext = { before: '', after: '', selected: '' };
  const bin = getBinaryPath('field-context');

  // Fallback: AppleScript reads the whole field value (no caret split), which
  // still enables the common "append to end" continuation case.
  const fallback = (): Promise<FieldContext> =>
    captureWindowContext()
      .then((ctx) => ({ before: ctx.existingFieldText || '', after: '', selected: ctx.selectedText || '' }))
      .catch(() => empty);

  return new Promise((resolve) => {
    if (!fs.existsSync(bin)) {
      fallback().then(resolve);
      return;
    }
    execFile(bin, [], { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) {
        fallback().then(resolve);
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        const result: FieldContext = {
          before: typeof parsed.before === 'string' ? parsed.before : '',
          after: typeof parsed.after === 'string' ? parsed.after : '',
          selected: typeof parsed.selected === 'string' ? parsed.selected : '',
        };
        if (!result.before && !result.after) {
          // Swift helper ran but found nothing (e.g. AX not yet trusted) — try AppleScript.
          fallback().then(resolve);
          return;
        }
        resolve(result);
      } catch {
        fallback().then(resolve);
      }
    });
  });
}

/**
 * Captures metadata about the currently focused window using AppleScript.
 * Non-invasive — does NOT touch the clipboard or simulate keystrokes.
 */
export function captureWindowContext(): Promise<WindowContext> {
  // Uses Accessibility API attributes to get selected text and existing field value
  const script = `
    set output to ""
    set selText to ""
    set fieldText to ""
    try
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        set bundleId to bundle identifier of frontApp
        set output to appName & "|||" & bundleId
        try
          set winTitle to name of front window of frontApp
          set output to output & "|||" & winTitle
        on error
          set output to output & "|||"
        end try
        try
          set focusedElem to value of attribute "AXFocusedUIElement" of frontApp
          -- Read selected text (kAXSelectedTextAttribute)
          try
            set selText to value of attribute "AXSelectedText" of focusedElem
          end try
          -- Read full field value (kAXValueAttribute) for continuation context
          try
            set fieldText to value of attribute "AXValue" of focusedElem
          end try
        on error
          set selText to ""
          set fieldText to ""
        end try
      end tell
    on error
      set output to "|||"
    end try
    return output & "|||" & selText & "|||" & fieldText
  `;

  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 3000 }, (err, stdout) => {
      if (err) {
        console.warn('[context] Failed to capture window context:', err.message);
        resolve({ appName: '', windowTitle: '', bundleId: '', selectedText: '', existingFieldText: '' });
        return;
      }

      const parts = stdout.trim().split('|||');
      resolve({
        appName: (parts[0] || '').trim(),
        bundleId: (parts[1] || '').trim(),
        windowTitle: (parts[2] || '').trim(),
        selectedText: (parts[3] || '').trim(),
        existingFieldText: (parts[4] || '').trim(),
      });
    });
  });
}

/**
 * Captures a screenshot of the frontmost window.
 * Uses macOS `screencapture` — non-invasive, no UI flash with -x flag.
 * Returns the path to the temporary PNG file, or undefined on failure.
 */
export function captureScreenshot(): Promise<string | undefined> {
  const tmpPath = path.join(os.tmpdir(), `echo-ctx-${Date.now()}.png`);

  return new Promise((resolve) => {
    // -x: no sound, -l: capture specific window (we use -w for interactive or -C for screen)
    // Using -x (silent) and capturing the whole screen, then we send it to the vision model
    // -C captures the screen including the cursor
    execFile('screencapture', ['-x', '-C', '-t', 'png', tmpPath], { timeout: 5000 }, (err) => {
      if (err) {
        console.warn('[context] Screenshot capture failed:', err.message);
        resolve(undefined);
        return;
      }

      if (!fs.existsSync(tmpPath)) {
        resolve(undefined);
        return;
      }

      console.log(`[context] Screenshot captured: ${tmpPath}`);
      resolve(tmpPath);
    });
  });
}

/**
 * Compresses a PNG screenshot to JPEG, resized to max 1024px on the longest side.
 * Returns the path to the compressed JPEG, or the original path on failure.
 */
export function compressScreenshot(pngPath: string): Promise<string> {
  const jpegPath = pngPath.replace(/\.png$/, '.jpg');

  return new Promise((resolve) => {
    // Use sips (built into macOS) to resize and convert to JPEG
    const maxDim = '1024';
    execFile('sips', [
      '--resampleHeightWidthMax', maxDim,
      '--setProperty', 'format', 'jpeg',
      '--setProperty', 'formatOptions', '50', // 50% quality
      pngPath,
      '--out', jpegPath,
    ], { timeout: 5000 }, (err) => {
      if (err) {
        console.warn('[context] Screenshot compression failed, using original:', err.message);
        resolve(pngPath);
        return;
      }

      // Check file size — cap at 500KB
      try {
        const stats = fs.statSync(jpegPath);
        if (stats.size > 500 * 1024) {
          console.warn(`[context] Compressed screenshot still ${Math.round(stats.size / 1024)}KB, using anyway`);
        } else {
          console.log(`[context] Screenshot compressed: ${Math.round(stats.size / 1024)}KB`);
        }
      } catch { /* ignore stat errors */ }

      resolve(jpegPath);
    });
  });
}

/**
 * Reads a screenshot file and returns it as a base64-encoded string.
 * If the file is a JPEG, returns jpeg media type info.
 */
export function screenshotToBase64(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return buffer.toString('base64');
}

/**
 * Returns the media type for a screenshot file path.
 */
export function screenshotMediaType(filePath: string): 'image/png' | 'image/jpeg' {
  return filePath.endsWith('.jpg') || filePath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
}

/**
 * Cleans up a temporary screenshot file.
 */
export function cleanupScreenshot(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* ignore cleanup errors */ }
}

export function formatWindowContext(ctx: WindowContext): string {
  if (!ctx.appName && !ctx.windowTitle) return '';

  const parts: string[] = [];
  if (ctx.appName) parts.push(`App: ${ctx.appName}`);
  if (ctx.bundleId) parts.push(`Bundle: ${ctx.bundleId}`);
  if (ctx.windowTitle) parts.push(`Window: ${ctx.windowTitle}`);
  if (ctx.selectedText) parts.push(`Selected text: ${ctx.selectedText.slice(0, 300)}`);
  if (ctx.existingFieldText) parts.push(`Existing text in field: ${ctx.existingFieldText.slice(0, 500)}`);

  return parts.join('\n');
}
