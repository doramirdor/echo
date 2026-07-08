import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { ensureSwiftBinary, getBinaryPath } from '../utils/swiftBinary';

const BIN_NAME = 'live-transcribe';

export class LiveTranscriber extends EventEmitter {
  private proc: ChildProcess | null = null;
  private lineBuffer = '';

  isReady(): boolean {
    return ensureSwiftBinary(BIN_NAME, 'scripts/live-transcribe.swift');
  }

  start(): void {
    if (this.proc) return;

    if (!this.isReady()) {
      console.warn('[live-transcribe] Binary not available');
      return;
    }

    this.lineBuffer = '';
    const proc = spawn(getBinaryPath(BIN_NAME), [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    proc.stdout?.on('data', (data: Buffer) => {
      this.lineBuffer += data.toString();
      const parts = this.lineBuffer.split('\n');
      this.lineBuffer = parts.pop() ?? '';
      for (const line of parts) {
        if (line.startsWith('partial:')) {
          this.emit('partial', line.slice(8));
        } else if (line.startsWith('final:')) {
          this.emit('final', line.slice(6));
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      console.log(`[live-transcribe] ${data.toString().trim()}`);
    });

    // Only clear this.proc if it still points at *this* process — a stale
    // close/error from a drained previous session must not null a newer one.
    proc.on('close', () => {
      if (this.proc === proc) this.proc = null;
    });

    proc.on('error', (err) => {
      console.error('[live-transcribe] error:', err.message);
      if (this.proc === proc) this.proc = null;
    });
  }

  stop(): void {
    const proc = this.proc;
    if (!proc) return;
    // Detach immediately so a rapid re-record can start() a fresh session
    // while this one drains its final result.
    this.proc = null;
    try {
      proc.stdin?.write('stop\n');
      // Give it a moment to flush final result, then force kill with SIGKILL
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, 1500);
    } catch {
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    }
  }

  /**
   * Force-kill immediately. Used during app shutdown.
   */
  forceStop(): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
  }
}
