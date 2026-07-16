import { execFileSync } from 'child_process';

/**
 * The 🌐/fn key vs. Echo's primary hotkey.
 *
 * macOS binds a lone fn (🌐) tap to a system action via the `AppleFnUsageType`
 * preference — the "Press 🌐 key to" dropdown in System Settings → Keyboard:
 *   0 = Do Nothing, 1 = Change Input Source, 2 = Show Emoji & Symbols, 3 = Start Dictation.
 * When it's anything but 0 (1 is the built-in default on Macs with a globe key),
 * macOS consumes the fn tap for that action before Echo's listen-only event tap
 * ever sees it, so the fn hotkey looks dead. The tap must stay listen-only — an
 * active tap that swallowed fn would also break fn-as-modifier (fn+arrows,
 * fn+F-keys) — so the only clean fix is to set the pref to 0. That's what Wispr
 * Flow and similar dictation apps do on first run instead of the manual trip
 * through System Settings. Mirror of src-tauri/src/utils/fn_key_release.rs.
 */

/** Read `AppleFnUsageType` from NSGlobalDomain, or null when unset/unreadable. */
function readFnUsageType(): number | null {
  try {
    const out = execFileSync('defaults', ['read', '-g', 'AppleFnUsageType'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const n = Number.parseInt(out, 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    // Key unset → `defaults` exits non-zero. macOS then uses its built-in
    // default ("Change Input Source" on Macs with a globe key): not free.
    return null;
  }
}

/** True when fn is already set to do nothing (Echo's hotkey is unobstructed). */
export function isFnKeyFree(): boolean {
  return readFnUsageType() === 0;
}

/**
 * fn-key availability in the `{ ok, status }` shape the permissions panel uses,
 * so it renders through the same badge/refresh path as the real TCC permissions.
 */
export function getFnKeyStatus(): { ok: boolean; status: string } {
  if (process.platform !== 'darwin') return { ok: true, status: 'free' };
  const free = isFnKeyFree();
  return { ok: free, status: free ? 'free' : 'captured' };
}

/**
 * Set "Press 🌐 key to" → Do Nothing so a lone fn tap reaches Echo. Returns
 * whether the write succeeded. HIToolbox may only pick the change up at the next
 * login, so callers should tell the user to log out/in if fn is still captured.
 */
export function freeFnKey(): boolean {
  try {
    execFileSync('defaults', ['write', '-g', 'AppleFnUsageType', '-int', '0'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}
