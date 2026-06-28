import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { ensureSwiftBinary, getBinaryPath } from '../utils/swiftBinary';

const BIN_NAME = 'live-transcribe';

export class LiveTranscriber extends EventEmitter {
  private proc: ChildProcess | null = null;

  isReady(): boolean {
    return ensureSwiftBinary(BIN_NAME, 'scripts/live-transcribe.swift');
  }

  start(): void {
    if (this.proc) return;

    if (!this.isReady()) {
      console.warn('[live-transcribe] Binary not available');
      return;
    }

    this.proc = spawn(getBinaryPath(BIN_NAME), [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        if (line.startsWith('partial:')) {
          this.emit('partial', line.slice(8));
        } else if (line.startsWith('final:')) {
          this.emit('final', line.slice(6));
        }
      }
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      console.log(`[live-transcribe] ${data.toString().trim()}`);
    });

    this.proc.on('close', () => {
      this.proc = null;
    });

    this.proc.on('error', (err) => {
      console.error('[live-transcribe] error:', err.message);
      this.proc = null;
    });
  }

  stop(): void {
    if (!this.proc) return;
    try {
      this.proc.stdin?.write('stop\n');
      const proc = this.proc;
      // Give it a moment to flush final result, then force kill with SIGKILL
      setTimeout(() => {
        if (this.proc === proc && this.proc) {
          try { this.proc.kill('SIGKILL'); } catch { /* already dead */ }
          this.proc = null;
        }
      }, 1500);
    } catch {
      try { this.proc?.kill('SIGKILL'); } catch { /* already dead */ }
      this.proc = null;
    }
  }

  /**
   * Force-kill immediately. Used during app shutdown.
   */
  forceStop(): void {
    if (!this.proc) return;
    try { this.proc.kill('SIGKILL'); } catch { /* already dead */ }
    this.proc = null;
  }
}
