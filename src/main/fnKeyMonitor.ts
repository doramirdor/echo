import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { ensureSwiftBinary, getBinaryPath } from './utils/swiftBinary';

const BIN_NAME = 'fn-monitor';

// Window in which a second fn-down counts as a double-click. The press→hold
// classification now happens in the consumer (index.ts) so recording can start
// instantly on the very first press; the monitor only disambiguates a double-tap.
const DOUBLE_CLICK_WINDOW_MS = 280;
const RESTART_DELAY_MS = 2000;
const MAX_RESTART_ATTEMPTS = 5;
// After the restart budget is exhausted, allow a fresh burst of retries this
// often — otherwise a transient failure (e.g. flaky Input Monitoring state)
// would kill the primary hotkey for the rest of a days-long session.
const RESTART_BUDGET_RESET_MS = 10 * 60 * 1000;

export type FnAction = 'press' | 'release' | 'double-click' | 'combo';

/**
 * Monitors the fn/Globe key and emits low-level, instant actions:
 * - 'press':        fn pressed down (every fn-down except a double-click's 2nd tap)
 * - 'release':      fn released (every fn-up)
 * - 'double-click': fn tapped twice within DOUBLE_CLICK_WINDOW_MS
 * - 'combo':        another key went down while fn was held (fn used as a modifier,
 *                    e.g. fn+Delete/fn+←, not as Echo's standalone hotkey) — the
 *                    consumer should cancel/ignore the in-progress press
 *
 * Gesture *meaning* (hold-to-talk vs hands-free vs stray tap) is decided by the
 * consumer from the press/release timing — keeping this monitor latency-free so
 * recording can begin the instant fn goes down.
 *
 * Also emits 'dead' (once per exhaustion, with { inputMonitoring }) when the
 * restart budget runs out, so the app can surface it to the user; the budget
 * refreshes every RESTART_BUDGET_RESET_MS and retries automatically.
 */
export class FnKeyMonitor extends EventEmitter {
  private proc: ChildProcess | null = null;
  private lastFnUpTime = 0;
  private tapWindowTimer: ReturnType<typeof setTimeout> | null = null;
  private waitingForSecondTap = false;
  private lineBuffer = '';
  private stopping = false;
  private restartAttempts = 0;
  private deadEmitted = false;
  private budgetResetTimer: ReturnType<typeof setInterval> | null = null;
  private _inputMonitoring: 'granted' | 'denied' | 'unknown' = 'unknown';

  /** Input Monitoring permission as reported by the monitor process itself. */
  get inputMonitoring(): 'granted' | 'denied' | 'unknown' {
    return this._inputMonitoring;
  }

  static ensureBinary(): boolean {
    return ensureSwiftBinary(BIN_NAME, 'scripts/fn-monitor.swift');
  }

  start(): void {
    if (this.proc) return;
    this.stopping = false;
    this.ensureBudgetResetTimer();

    if (!FnKeyMonitor.ensureBinary()) {
      console.warn('[fn-monitor] Cannot start — binary not available');
      return;
    }

    this.lineBuffer = '';
    this.proc = spawn(getBinaryPath(BIN_NAME), [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout?.on('data', (data: Buffer) => {
      this.lineBuffer += data.toString();
      const parts = this.lineBuffer.split('\n');
      this.lineBuffer = parts.pop() ?? '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (trimmed === 'fn-down') this.onFnDown();
        else if (trimmed === 'fn-up') this.onFnUp();
        else if (trimmed === 'fn-combo') this.emit('action', 'combo' as FnAction);
        else if (trimmed === 'im-granted') this._inputMonitoring = 'granted';
        else if (trimmed === 'im-denied') this._inputMonitoring = 'denied';
        else if (trimmed === 'im-unknown') this._inputMonitoring = 'unknown';
        else if (trimmed === 'ready') {
          this.restartAttempts = 0;
          this.deadEmitted = false;
          console.log('[fn-monitor] Running');
        }
      }
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      console.warn(`[fn-monitor] ${data.toString().trim()}`);
    });

    this.proc.on('close', (code) => {
      console.log(`[fn-monitor] Exited with code ${code}`);
      this.proc = null;
      this.resetGestureState();

      if (this.stopping) return;

      if (this.restartAttempts < MAX_RESTART_ATTEMPTS) {
        this.restartAttempts++;
        console.log(`[fn-monitor] Restarting (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS})...`);
        setTimeout(() => this.start(), RESTART_DELAY_MS);
      } else if (!this.deadEmitted) {
        this.deadEmitted = true;
        console.warn('[fn-monitor] Restart budget exhausted — retrying in ~10 minutes');
        this.emit('dead', { inputMonitoring: this.inputMonitoring });
      }
    });

    this.proc.on('error', (err) => {
      console.error('[fn-monitor] Error:', err.message);
      this.proc = null;
    });
  }

  // Periodically refresh the restart budget so an exhausted monitor gets a
  // fresh burst of retries instead of staying dead for the rest of the session.
  private ensureBudgetResetTimer(): void {
    if (this.budgetResetTimer) return;
    this.budgetResetTimer = setInterval(() => {
      if (this.stopping) return;
      this.restartAttempts = 0;
      this.deadEmitted = false;
      if (!this.proc) {
        console.log('[fn-monitor] Restart budget refreshed — retrying');
        this.start();
      }
    }, RESTART_BUDGET_RESET_MS);
    this.budgetResetTimer.unref?.();
  }

  private clearBudgetResetTimer(): void {
    if (this.budgetResetTimer) {
      clearInterval(this.budgetResetTimer);
      this.budgetResetTimer = null;
    }
  }

  private resetGestureState(): void {
    this.waitingForSecondTap = false;
    if (this.tapWindowTimer) { clearTimeout(this.tapWindowTimer); this.tapWindowTimer = null; }
  }

  private onFnDown(): void {
    const now = Date.now();

    if (this.waitingForSecondTap && (now - this.lastFnUpTime) < DOUBLE_CLICK_WINDOW_MS) {
      // Second tap of a double-click — emit the high-level gesture instead of a
      // bare press so the consumer can lock into hands-free mode.
      this.waitingForSecondTap = false;
      if (this.tapWindowTimer) { clearTimeout(this.tapWindowTimer); this.tapWindowTimer = null; }
      this.emit('action', 'double-click' as FnAction);
      return;
    }

    this.emit('action', 'press' as FnAction);
  }

  private onFnUp(): void {
    this.lastFnUpTime = Date.now();
    this.emit('action', 'release' as FnAction);

    // Arm the double-click window: a fn-down within DOUBLE_CLICK_WINDOW_MS is a
    // double-click; otherwise it lapses and the next press starts fresh.
    this.waitingForSecondTap = true;
    if (this.tapWindowTimer) { clearTimeout(this.tapWindowTimer); }
    this.tapWindowTimer = setTimeout(() => {
      this.waitingForSecondTap = false;
      this.tapWindowTimer = null;
    }, DOUBLE_CLICK_WINDOW_MS);
  }

  stop(): void {
    this.stopping = true;
    this.clearBudgetResetTimer();
    if (!this.proc) return;
    try {
      this.proc.stdin?.write('quit\n');
      const proc = this.proc;
      setTimeout(() => {
        if (this.proc === proc && this.proc) {
          try { this.proc.kill('SIGKILL'); } catch { /* already dead */ }
          this.proc = null;
        }
      }, 1000);
    } catch {
      try { this.proc?.kill('SIGKILL'); } catch { /* already dead */ }
      this.proc = null;
    }
  }

  forceStop(): void {
    this.stopping = true;
    this.clearBudgetResetTimer();
    this.resetGestureState();
    if (!this.proc) return;
    try { this.proc.kill('SIGKILL'); } catch { /* already dead */ }
    this.proc = null;
  }
}
