import { app } from 'electron';

/**
 * Input Monitoring (TCC) status for the Echo *main process* via
 * `IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)`.
 *
 * Why not just trust the `fn-monitor` helper's self-report? In a packaged build
 * the app is a single "Echo" TCC identity, but a bundled helper binary is its
 * own AX/IM subject even when it isn't disclaimed, so the helper's own
 * `IOHIDCheckAccess` comes back "denied" while the "Echo" row the user toggled
 * in System Settings is actually granted. Querying from THIS process (Echo)
 * matches that row — the same reason Accessibility uses
 * `systemPreferences.isTrustedAccessibilityClient` and the Tauri build uses
 * `input_monitoring_status_direct()` (see src-tauri/src/lib.rs).
 *
 * Electron exposes no built-in Input Monitoring API, so we read it through koffi
 * (a prebuilt FFI — no node-gyp). Only used in packaged builds; dev keeps the
 * helper's self-report, where the helper disclaims to its own identity and that
 * grant is what actually gates the fn hotkey.
 */

// kIOHIDRequestTypeListenEvent (IOKit/hid/IOHIDKeys.h). Access types:
// kIOHIDAccessTypeGranted 0, kIOHIDAccessTypeDenied 1, kIOHIDAccessTypeUnknown 2.
const K_IOHID_REQUEST_TYPE_LISTEN_EVENT = 1;

type IMStatus = { ok: boolean; status: string };

// Lazily resolve the FFI binding once; a load failure (unexpected arch, missing
// framework) degrades to null so callers fall back to the helper report.
let checkAccess: ((request: number) => number) | null | undefined;

function resolveChecker(): ((request: number) => number) | null {
  if (checkAccess !== undefined) return checkAccess;
  try {
    // Require lazily (not a top-level import) so a koffi load failure can never
    // break app startup — it degrades to the helper fallback instead.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const iokit = koffi.load('/System/Library/Frameworks/IOKit.framework/IOKit');
    checkAccess = iokit.func('int IOHIDCheckAccess(uint32_t request)') as (r: number) => number;
  } catch {
    checkAccess = null;
  }
  return checkAccess;
}

/**
 * Direct in-process Input Monitoring status, or null when it can't be determined
 * here (non-macOS, koffi unavailable) so the caller can fall back to the
 * `fn-monitor` helper's self-report.
 */
export function getInputMonitoringStatusDirect(): IMStatus | null {
  if (process.platform !== 'darwin') return null;
  const fn = resolveChecker();
  if (!fn) return null;
  try {
    switch (fn(K_IOHID_REQUEST_TYPE_LISTEN_EVENT)) {
      case 0: return { ok: true, status: 'granted' };
      case 1: return { ok: false, status: 'denied' };
      default: return { ok: false, status: 'unknown' };
    }
  } catch {
    return null;
  }
}

/**
 * Resolve Input Monitoring status for the permissions panel. In a packaged build
 * prefer the authoritative in-process query (the "Echo" row); otherwise, and as
 * a fallback, use the `fn-monitor` helper's self-reported status.
 */
export function resolveInputMonitoringStatus(helperStatus: string): IMStatus {
  if (app.isPackaged) {
    const direct = getInputMonitoringStatusDirect();
    if (direct) return direct;
  }
  return { ok: helperStatus === 'granted', status: helperStatus };
}
