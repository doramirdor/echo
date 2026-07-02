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

export type FnAction = 'press' | 'release' | 'double-click';

/**
 * Monitors the fn/Globe key and emits low-level, instant actions:
 * - 'press':        fn pressed down (every fn-down except a double-click's 2nd tap)
 * - 'release':      fn released (every fn-up)
 * - 'double-click': fn tapped twice within DOUBLE_CLICK_WINDOW_MS
 *
 * Gesture *meaning* (hold-to-talk vs hands-free vs stray tap) is decided by the
 * consumer from the press/release timing — keeping this monitor latency-free so
 * recording can begin the instant fn goes down.
 */
export class FnKeyMonitor extends EventEmitter {
  private proc: ChildProcess | null = null;
  private lastFnUpTime = 0;
  private tapWindowTimer: ReturnType<typeof setTimeout> | null = null;
  private waitingForSecondTap = false;
  private lineBuffer = '';
  private stopping = false;
  private restartAttempts = 0;
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
        else if (trimmed === 'im-granted') this._inputMonitoring = 'granted';
        else if (trimmed === 'im-denied') this._inputMonitoring = 'denied';
        else if (trimmed === 'im-unknown') this._inputMonitoring = 'unknown';
        else if (trimmed === 'ready') {
          this.restartAttempts = 0;
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

      if (!this.stopping && this.restartAttempts < MAX_RESTART_ATTEMPTS) {
        this.restartAttempts++;
        console.log(`[fn-monitor] Restarting (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS})...`);
        setTimeout(() => this.start(), RESTART_DELAY_MS);
      }
    });

    this.proc.on('error', (err) => {
      console.error('[fn-monitor] Error:', err.message);
      this.proc = null;
    });
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
    this.resetGestureState();
    if (!this.proc) return;
    try { this.proc.kill('SIGKILL'); } catch { /* already dead */ }
    this.proc = null;
  }
}
