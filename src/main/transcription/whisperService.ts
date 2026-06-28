import { execFile, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';

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

export class WhisperService {
  private binaryPath: string;

  constructor() {
    this.binaryPath = path.join(BIN_DIR, 'whisper-cli');
  }

  private getModelPath(modelName?: string): string {
    const name = modelName || 'ggml-base.en.bin';
    return path.join(MODELS_DIR, name);
  }

  /**
   * Check if whisper.cpp binary and model are available.
   */
  isReady(modelName?: string): { binary: boolean; model: boolean } {
    return {
      binary: fs.existsSync(this.binaryPath),
      model: fs.existsSync(this.getModelPath(modelName)),
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
  async downloadModel(onProgress?: (percent: number) => void, modelName?: string): Promise<void> {
    const name = modelName || 'ggml-base.en.bin';
    const modelPath = this.getModelPath(name);
    const modelUrl = MODEL_BASE_URL + name;

    fs.mkdirSync(MODELS_DIR, { recursive: true });

    if (fs.existsSync(modelPath)) {
      console.log(`[whisper] Model ${name} already exists`);
      return;
    }

    console.log(`[whisper] Downloading model from ${modelUrl}...`);

    return new Promise((resolve, reject) => {
      const download = (url: string) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            const location = response.headers.location;
            if (location) { download(location); return; }
          }

          if (response.statusCode !== 200) {
            reject(new Error(`Download failed with status ${response.statusCode}`));
            return;
          }

          const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
          let downloadedBytes = 0;

          const tmpPath = modelPath + '.tmp';
          const file = fs.createWriteStream(tmpPath);

          response.on('data', (chunk: Buffer) => {
            downloadedBytes += chunk.length;
            if (totalBytes > 0 && onProgress) {
              onProgress(Math.round((downloadedBytes / totalBytes) * 100));
            }
          });

          response.pipe(file);

          file.on('finish', () => {
            file.close();
            fs.renameSync(tmpPath, modelPath);
            console.log(`[whisper] Model downloaded to ${modelPath}`);
            resolve();
          });

          file.on('error', (err) => {
            fs.unlinkSync(tmpPath);
            reject(err);
          });
        }).on('error', reject);
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
    onProgress?.('Done! whisper-cli installed.');
  }

  /**
   * Get paths for setup instructions.
   */
  static getPaths() {
    return { APP_SUPPORT_DIR, MODELS_DIR, BIN_DIR };
  }
}
