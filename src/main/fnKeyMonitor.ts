import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { ensureSwiftBinary, getBinaryPath } from './utils/swiftBinary';

const BIN_NAME = 'fn-monitor';

const HOLD_THRESHOLD_MS = 120;
const DOUBLE_CLICK_WINDOW_MS = 400;
const RESTART_DELAY_MS = 2000;
const MAX_RESTART_ATTEMPTS = 5;

export type FnAction = 'hold-start' | 'hold-end' | 'double-click' | 'single-click';

/**
 * Monitors the fn/Globe key and emits high-level actions:
 * - 'hold-start': fn held down past threshold (start hold-to-record)
 * - 'hold-end': fn released after a hold (stop hold-to-record)
 * - 'double-click': fn double-tapped (toggle recording on/off)
 * - 'single-click': fn tapped once (stops toggle recording if active)
 */
export class FnKeyMonitor extends EventEmitter {
  private proc: ChildProcess | null = null;
  private lastFnUpTime = 0;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private singleTapTimer: ReturnType<typeof setTimeout> | null = null;
  private inHold = false;
  private waitingForSecondTap = false;
  private suppressNextUp = false;
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
    this.inHold = false;
    this.waitingForSecondTap = false;
    this.suppressNextUp = false;
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    if (this.singleTapTimer) { clearTimeout(this.singleTapTimer); this.singleTapTimer = null; }
  }

  private onFnDown(): void {
    const now = Date.now();

    if (this.waitingForSecondTap && (now - this.lastFnUpTime) < DOUBLE_CLICK_WINDOW_MS) {
      this.waitingForSecondTap = false;
      if (this.singleTapTimer) { clearTimeout(this.singleTapTimer); this.singleTapTimer = null; }
      if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
      this.suppressNextUp = true;
      this.emit('action', 'double-click' as FnAction);
      return;
    }

    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.inHold = true;
      this.emit('action', 'hold-start' as FnAction);
    }, HOLD_THRESHOLD_MS);
  }

  private onFnUp(): void {
    this.lastFnUpTime = Date.now();

    if (this.suppressNextUp) {
      this.suppressNextUp = false;
      return;
    }

    if (this.inHold) {
      this.inHold = false;
      this.emit('action', 'hold-end' as FnAction);
      return;
    }

    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }

    this.waitingForSecondTap = true;
    this.singleTapTimer = setTimeout(() => {
      this.waitingForSecondTap = false;
      this.singleTapTimer = null;
      this.emit('action', 'single-click' as FnAction);
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
