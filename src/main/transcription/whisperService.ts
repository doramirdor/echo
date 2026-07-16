import { execFile, spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { pipeline } from 'stream';

const APP_SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'echo');
const MODELS_DIR = path.join(APP_SUPPORT_DIR, 'models');
const BIN_DIR = path.join(APP_SUPPORT_DIR, 'bin');

const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

export const WHISPER_MODELS = [
  { name: 'ggml-tiny.en.bin', label: 'Tiny (English)', size: '~75MB' },
  { name: 'ggml-base.en.bin', label: 'Base (English)', size: '~142MB' },
  { name: 'ggml-small.en.bin', label: 'Small (English)', size: '~488MB' },
  { name: 'ggml-medium.en.bin', label: 'Medium (English)', size: '~1.5GB' },
  { name: 'ggml-large-v3-turbo.bin', label: 'Large v3 Turbo', size: '~1.6GB' },
] as const;

interface WarmServer {
  modelPath: string;
  ready?: Promise<number | null>;
  proc?: ChildProcess;
}

/**
 * A download-progress tick. `percent` is 0–100; `bytesPerSec` is a short rolling
 * average of transfer speed. `total` is 0 when the server sends no
 * Content-Length, in which case the UI should fall back to bytes-only display.
 */
export interface DownloadProgress {
  percent: number;
  downloaded: number;
  total: number;
  bytesPerSec: number;
}

export class WhisperService {
  private binaryPath: string;
  private serverBinaryPath: string;
  private serverState: WarmServer | null = null;
  private serverDisabled = false;
  private downloadsInFlight = new Map<string, Promise<void>>();

  constructor() {
    this.binaryPath = path.join(BIN_DIR, 'whisper-cli');
    this.serverBinaryPath = path.join(BIN_DIR, 'whisper-server');
  }

  private getModelPath(modelName?: string): string {
    const name = modelName || 'ggml-base.en.bin';
    // Model names arrive from the renderer and settings — keep them bare ggml
    // filenames so they can't escape MODELS_DIR or rewrite the download URL.
    if (!/^ggml-[A-Za-z0-9._-]+\.bin$/.test(name)) {
      throw new Error(`Invalid whisper model name: ${name}`);
    }
    return path.join(MODELS_DIR, name);
  }

  /**
   * Check if whisper.cpp binary and model are available.
   */
  isReady(modelName?: string): { binary: boolean; model: boolean } {
    let model = false;
    try {
      model = fs.existsSync(this.getModelPath(modelName));
    } catch { /* invalid model name — report as not downloaded */ }
    return {
      binary: fs.existsSync(this.binaryPath),
      model,
    };
  }

  /**
   * Transcribe a WAV file to text using whisper.cpp CLI.
   *
   * @param opts.language  ISO code (e.g. 'en') or 'auto' to detect.
   * @param opts.prompt    Initial prompt that biases decoding toward the user's
   *                       vocabulary/jargon — improves accuracy on names and
   *                       technical terms before any LLM cleanup runs.
   */
  async transcribe(
    wavPath: string,
    modelName?: string,
    opts?: { language?: string; prompt?: string },
  ): Promise<string> {
    const modelPath = this.getModelPath(modelName);
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`whisper.cpp binary not found at ${this.binaryPath}. Run the setup script.`);
    }
    if (!fs.existsSync(modelPath)) {
      throw new Error(`Whisper model not found at ${modelPath}. Download it in Settings.`);
    }

    // Use most cores for speed, but leave one for the rest of the system.
    const threads = Math.max(1, os.cpus().length - 1);
    const language = opts?.language && opts.language.trim() ? opts.language.trim() : 'en';

    // Warm-server path: whisper-server keeps the model + Metal context loaded
    // between dictations, skipping the 300-800ms cold init the CLI pays every
    // run. Any spawn/HTTP failure falls back silently to the CLI below.
    const warm = await this.transcribeViaServer(wavPath, modelPath, threads, {
      language,
      prompt: opts?.prompt?.trim() || undefined,
    });
    if (warm !== null) {
      console.log(`[whisper] Transcribed (warm): "${warm}"`);
      return warm;
    }

    const args = [
      '-m', modelPath,
      '-f', wavPath,
      '--no-timestamps',
      '-nt',                 // no token timestamps
      '-l', language,        // language ('auto' detects)
      '-t', String(threads), // threads — meaningful speed win on multi-core
    ];

    if (opts?.prompt && opts.prompt.trim()) {
      args.push('--prompt', opts.prompt.trim());
    }

    return new Promise((resolve, reject) => {
      execFile(this.binaryPath, args, { timeout: 120000 }, (error, stdout, stderr) => {
        if (error) {
          console.error('[whisper] stderr:', stderr);
          reject(new Error(`Whisper transcription failed: ${error.message}`));
          return;
        }

        const text = stdout.trim();
        console.log(`[whisper] Transcribed: "${text}"`);
        resolve(text);
      });
    });
  }

  /**
   * Kill the warm whisper-server child, if any. Called by the app entry on quit.
   */
  shutdown(): void {
    this.stopServer();
  }

  private stopServer(): void {
    const state = this.serverState;
    this.serverState = null;
    if (state?.proc && state.proc.exitCode === null) {
      try { state.proc.kill(); } catch { /* already gone */ }
    }
  }

  private async transcribeViaServer(
    wavPath: string,
    modelPath: string,
    threads: number,
    opts: { language: string; prompt?: string },
  ): Promise<string | null> {
    try {
      // Cap the wait so a slow-loading model doesn't stall the first dictation;
      // the server keeps warming in the background for the next run.
      const port = await this.raceReady(this.ensureServer(modelPath, threads), 4000);
      if (port === null) return null;
      return await this.requestInference(port, wavPath, opts);
    } catch {
      return null; // silent fallback to the CLI path
    }
  }

  private ensureServer(modelPath: string, threads: number): Promise<number | null> {
    if (this.serverDisabled) return Promise.resolve(null);
    if (this.serverState && this.serverState.modelPath !== modelPath) {
      this.stopServer(); // model changed — restart on the new one
    }
    let state = this.serverState;
    if (!state) {
      if (!fs.existsSync(this.serverBinaryPath)) {
        this.serverDisabled = true;
        console.log('[whisper] whisper-server not installed — using one-shot CLI');
        return Promise.resolve(null);
      }
      state = { modelPath };
      this.serverState = state;
      state.ready = this.startServer(state, threads);
    }
    return state.ready ?? Promise.resolve(null);
  }

  private async startServer(state: WarmServer, threads: number): Promise<number | null> {
    try {
      const port = await this.findFreePort();
      const proc = spawn(this.serverBinaryPath, [
        '-m', state.modelPath,
        '--host', '127.0.0.1',
        '--port', String(port),
        '-t', String(threads),
      ], { stdio: ['ignore', 'ignore', 'ignore'] });
      state.proc = proc;
      proc.on('error', () => { /* surfaces as waitForPort giving up */ });
      proc.on('exit', () => {
        // Crash after startup: clear state so the next dictation restarts it.
        if (this.serverState === state) this.serverState = null;
      });
      if (this.serverState !== state) {
        try { proc.kill(); } catch { /* already gone */ }
        return null;
      }
      const ok = await this.waitForPort(port, proc, 30000);
      if (!ok || this.serverState !== state) {
        try { proc.kill(); } catch { /* already gone */ }
        if (this.serverState === state) {
          // Binary exists but never came up — don't retry every dictation.
          this.serverState = null;
          this.serverDisabled = true;
          console.log('[whisper] whisper-server failed to start — using one-shot CLI');
        }
        return null;
      }
      console.log(`[whisper] whisper-server warm on 127.0.0.1:${port}`);
      return port;
    } catch {
      if (this.serverState === state) {
        this.serverState = null;
        this.serverDisabled = true;
      }
      return null;
    }
  }

  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => (port ? resolve(port) : reject(new Error('No free port'))));
      });
    });
  }

  private waitForPort(port: number, proc: ChildProcess, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const attempt = () => {
        if (proc.exitCode !== null) { resolve(false); return; }
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => {
          socket.destroy();
          if (Date.now() >= deadline) resolve(false);
          else setTimeout(attempt, 250);
        });
      };
      attempt();
    });
  }

  private raceReady(ready: Promise<number | null>, capMs: number): Promise<number | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), capMs);
      ready.then(
        (port) => { clearTimeout(timer); resolve(port); },
        () => { clearTimeout(timer); resolve(null); },
      );
    });
  }

  private requestInference(
    port: number,
    wavPath: string,
    opts: { language: string; prompt?: string },
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let wav: Buffer;
      try {
        wav = fs.readFileSync(wavPath);
      } catch (err) {
        reject(err);
        return;
      }

      const boundary = '----echo-whisper-' + Math.random().toString(16).slice(2);
      const parts: Buffer[] = [];
      const field = (name: string, value: string) => {
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ));
      };
      field('response_format', 'text');
      field('language', opts.language);
      if (opts.prompt) field('prompt', opts.prompt);
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
        'Content-Type: audio/wav\r\n\r\n',
      ));
      parts.push(wav);
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
      const body = Buffer.concat(parts);

      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/inference',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        timeout: 120000,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`whisper-server responded ${res.statusCode}`));
            return;
          }
          resolve(text.trim());
        });
      });
      req.on('timeout', () => req.destroy(new Error('whisper-server request timed out')));
      req.on('error', reject);
      req.end(body);
    });
  }

  /**
   * List downloaded models.
   */
  listDownloadedModels(): string[] {
    try {
      if (!fs.existsSync(MODELS_DIR)) return [];
      return fs.readdirSync(MODELS_DIR).filter(f => f.startsWith('ggml-') && f.endsWith('.bin'));
    } catch {
      return [];
    }
  }

  /**
   * Download a whisper model file.
   */
  async downloadModel(onProgress?: (progress: DownloadProgress) => void, modelName?: string): Promise<void> {
    const name = modelName || 'ggml-base.en.bin';
    const modelPath = this.getModelPath(name);

    // A second invocation while this model is downloading joins the in-flight
    // download instead of double-writing the same .tmp file.
    const inFlight = this.downloadsInFlight.get(name);
    if (inFlight) return inFlight;

    fs.mkdirSync(MODELS_DIR, { recursive: true });

    if (fs.existsSync(modelPath)) {
      console.log(`[whisper] Model ${name} already exists`);
      return;
    }

    const promise = this.performDownload(name, modelPath, onProgress).finally(() => {
      this.downloadsInFlight.delete(name);
    });
    this.downloadsInFlight.set(name, promise);
    return promise;
  }

  private performDownload(
    name: string,
    modelPath: string,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<void> {
    const modelUrl = MODEL_BASE_URL + name;
    console.log(`[whisper] Downloading model from ${modelUrl}...`);

    return new Promise((resolve, reject) => {
      // Mid-transfer RSTs can fire several handlers; settle exactly once.
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve();
      };

      const download = (url: string, redirects = 0) => {
        // Model weights are executable-adjacent input — never fetch them over
        // plaintext HTTP, even via redirect, and don't follow redirect loops.
        if (!url.startsWith('https://')) {
          settle(new Error(`Refusing non-HTTPS model download URL: ${url}`));
          return;
        }
        https.get(url, (response) => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
            const location = response.headers.location;
            response.resume();
            if (location && redirects < 5) { download(location, redirects + 1); return; }
            settle(new Error('Download failed: too many redirects'));
            return;
          }

          if (response.statusCode !== 200) {
            response.resume();
            settle(new Error(`Download failed with status ${response.statusCode}`));
            return;
          }

          const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
          let downloadedBytes = 0;

          const tmpPath = modelPath + '.tmp';
          const file = fs.createWriteStream(tmpPath);

          // Throttle progress to ~10 ticks/sec (a chunk fires per-packet, which
          // would otherwise flood IPC) and derive a rolling transfer speed from
          // the bytes moved since the last tick.
          let lastEmit = Date.now();
          let lastBytes = 0;
          const emit = (final = false) => {
            if (!onProgress) return;
            const now = Date.now();
            const dt = (now - lastEmit) / 1000;
            if (!final && dt < 0.1) return;
            const bytesPerSec = dt > 0 ? (downloadedBytes - lastBytes) / dt : 0;
            lastEmit = now;
            lastBytes = downloadedBytes;
            onProgress({
              percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
              downloaded: downloadedBytes,
              total: totalBytes,
              bytesPerSec: Math.max(0, Math.round(bytesPerSec)),
            });
          };

          response.on('data', (chunk: Buffer) => {
            downloadedBytes += chunk.length;
            emit();
          });
          response.on('end', () => emit(true));

          // pipeline (unlike .pipe) surfaces mid-transfer aborts — which emit
          // no 'error' on the response, only 'aborted'/'close' — as
          // ERR_STREAM_PREMATURE_CLOSE, and destroys both streams.
          pipeline(response, file, (err) => {
            if (err) {
              try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
              settle(err);
              return;
            }
            try {
              fs.renameSync(tmpPath, modelPath);
            } catch (renameErr) {
              try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
              settle(renameErr as Error);
              return;
            }
            console.log(`[whisper] Model downloaded to ${modelPath}`);
            settle();
          });
        }).on('error', (err) => settle(err));
      };

      download(modelUrl);
    });
  }

  /**
   * Build whisper.cpp binary from source. Requires git and cmake.
   */
  async buildBinary(onProgress?: (message: string) => void): Promise<void> {
    if (fs.existsSync(this.binaryPath)) {
      onProgress?.('Binary already exists');
      return;
    }

    const tmpDir = path.join(os.tmpdir(), 'echo-whisper-build');

    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    const run = (cmd: string, args: string[], cwd: string): Promise<void> => {
      return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 300000,
          env: { ...process.env, PATH: (process.env.PATH || '') + ':/opt/homebrew/bin:/usr/local/bin' },
        });
        proc.stdout.on('data', (d: Buffer) => {
          const line = d.toString().trim();
          if (line) onProgress?.(line.slice(0, 120));
        });
        proc.stderr.on('data', (d: Buffer) => {
          const line = d.toString().trim();
          if (line) onProgress?.(line.slice(0, 120));
        });
        proc.on('error', reject);
        proc.on('close', (code: number) => {
          if (code !== 0) reject(new Error(`${cmd} exited with ${code}`));
          else resolve();
        });
      });
    };

    const repoDir = path.join(tmpDir, 'whisper.cpp');

    // Clone if needed
    if (!fs.existsSync(repoDir)) {
      onProgress?.('Cloning whisper.cpp...');
      await run('git', ['clone', '--depth', '1', 'https://github.com/ggerganov/whisper.cpp.git'], tmpDir);
    }

    // Build
    onProgress?.('Configuring build...');
    await run('cmake', ['-B', 'build', '-DCMAKE_BUILD_TYPE=Release'], repoDir);

    const cpus = os.cpus().length.toString();
    onProgress?.('Compiling whisper.cpp...');
    await run('cmake', ['--build', 'build', '--config', 'Release', '-j', cpus], repoDir);

    // Copy binary
    const builtBinary = path.join(repoDir, 'build', 'bin', 'whisper-cli');
    if (!fs.existsSync(builtBinary)) {
      throw new Error('Build succeeded but whisper-cli binary not found');
    }
    fs.copyFileSync(builtBinary, this.binaryPath);
    fs.chmodSync(this.binaryPath, 0o755);

    // Same build produces whisper-server, which powers the warm-transcription
    // path. Best-effort: the CLI path works without it.
    try {
      const builtServer = path.join(repoDir, 'build', 'bin', 'whisper-server');
      if (fs.existsSync(builtServer)) {
        fs.copyFileSync(builtServer, this.serverBinaryPath);
        fs.chmodSync(this.serverBinaryPath, 0o755);
      }
    } catch { /* optional */ }

    onProgress?.('Done! whisper-cli installed.');
  }

  /**
   * Get paths for setup instructions.
   */
  static getPaths() {
    return { APP_SUPPORT_DIR, MODELS_DIR, BIN_DIR };
  }
}
