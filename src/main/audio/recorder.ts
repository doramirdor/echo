import { execSync, spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// WAV header for 16kHz mono 16-bit PCM — file/data sizes filled on stop
function makeWavHeader(dataSize: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);       // PCM subchunk size
  header.writeUInt16LE(1, 20);        // PCM format
  header.writeUInt16LE(1, 22);        // mono
  header.writeUInt32LE(16000, 24);    // sample rate
  header.writeUInt32LE(32000, 28);    // byte rate (16000 * 1 * 2)
  header.writeUInt16LE(2, 32);        // block align
  header.writeUInt16LE(16, 34);       // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}

export class AudioRecorder extends EventEmitter {
  private process: ChildProcess | null = null;
  private outputPath: string = '';
  private writeStream: fs.WriteStream | null = null;
  private rawDataSize: number = 0;
  /** Multiplier for RMS level reporting (set higher for whisper mode). */
  levelBoost: number = 3;

  get recordingPath(): string {
    return this.outputPath;
  }

  /**
   * Start recording audio from the microphone using sox.
   * Records 16kHz mono 16-bit PCM, streams raw audio to stdout for level metering.
   * Emits 'level' events with normalized 0–1 amplitude values.
   * @param deviceName Optional audio input device name (e.g. "MacBook Pro Microphone")
   */
  start(deviceName?: string): void {
    if (this.process) {
      throw new Error('Already recording');
    }

    this.outputPath = path.join(os.tmpdir(), `echo-${Date.now()}.wav`);
    this.rawDataSize = 0;

    // Write placeholder WAV header (will be finalized on stop)
    this.writeStream = fs.createWriteStream(this.outputPath);
    this.writeStream.write(makeWavHeader(0));

    // Build environment — set AUDIODEV if a specific device is requested
    const env = { ...process.env };
    if (deviceName) {
      env.AUDIODEV = deviceName;
      console.log(`[recorder] Using audio device: ${deviceName}`);
    }

    // Output raw PCM to stdout so we can compute audio levels in real-time
    this.process = spawn('rec', [
      '-r', '16000',
      '-c', '1',
      '-b', '16',
      '-t', 'raw',
      '-',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      // Write raw PCM to WAV file
      this.writeStream?.write(chunk);
      this.rawDataSize += chunk.length;

      // Compute RMS level from 16-bit PCM samples
      let sumSq = 0;
      const samples = chunk.length >> 1; // 2 bytes per sample
      for (let i = 0; i < chunk.length - 1; i += 2) {
        const sample = chunk.readInt16LE(i);
        sumSq += sample * sample;
      }
      const rms = Math.sqrt(sumSq / samples) / 32768;
      this.emit('level', Math.min(1, rms * this.levelBoost));
    });

    this.process.on('error', (err) => {
      console.error('[recorder] Failed to start sox/rec:', err.message);
      console.error('[recorder] Install sox: brew install sox');
      this.process = null;
    });

    console.log(`[recorder] Recording to ${this.outputPath}`);
  }

  /**
   * Finalize the WAV header with the correct data size.
   */
  private finalizeWav(): void {
    if (!this.writeStream) return;
    this.writeStream.end();

    // Re-open and patch the header with actual sizes
    const fd = fs.openSync(this.outputPath, 'r+');
    const patch = Buffer.alloc(4);
    patch.writeUInt32LE(36 + this.rawDataSize, 0);
    fs.writeSync(fd, patch, 0, 4, 4);  // RIFF chunk size
    patch.writeUInt32LE(this.rawDataSize, 0);
    fs.writeSync(fd, patch, 0, 4, 40); // data subchunk size
    fs.closeSync(fd);
    this.writeStream = null;
  }

  /**
   * Stop recording and return the path to the WAV file.
   */
  stop(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.process) {
        reject(new Error('Not recording'));
        return;
      }

      const proc = this.process;
      this.process = null;
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.warn('[recorder] sox did not exit in time, sending SIGKILL');
        proc.kill('SIGKILL');
        this.finalizeWav();
        if (fs.existsSync(this.outputPath)) {
          resolve(this.outputPath);
        } else {
          reject(new Error('Recording file not found (timeout)'));
        }
      }, 5000);

      proc.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.finalizeWav();
        if (fs.existsSync(this.outputPath)) {
          const stats = fs.statSync(this.outputPath);
          console.log(`[recorder] Saved ${(stats.size / 1024).toFixed(1)}KB to ${this.outputPath}`);
          resolve(this.outputPath);
        } else {
          reject(new Error('Recording file not found'));
        }
      });

      // Send SIGTERM to gracefully stop sox
      proc.kill('SIGTERM');
    });
  }

  /**
   * Force-kill the recording process without waiting. Used during shutdown.
   */
  forceStop(): void {
    if (this.process) {
      this.process.kill('SIGKILL');
      this.process = null;
    }
  }

  /**
   * Post-process: clean audio for better transcription.
   *
   * Pipeline (applied in order based on settings):
   * 1. Noise reduction — capture noise profile from first 0.5s, subtract it
   * 2. Gain + compression — heavier boost in whisper mode for quiet speech
   * 3. Voice bandpass + normalization
   */
  postProcess(wavPath: string, options?: { noiseReduction?: boolean; whisperMode?: boolean }): string {
    const noiseReduction = options?.noiseReduction ?? true;
    const whisperMode = options?.whisperMode ?? false;
    const processedPath = wavPath.replace('.wav', '-clean.wav');

    try {
      let inputPath = wavPath;

      // Step 1: Noise reduction via SoX noisered
      if (noiseReduction) {
        const profilePath = wavPath.replace('.wav', '-noise.prof');
        const denoisedPath = wavPath.replace('.wav', '-denoised.wav');
        try {
          // Extract noise profile from first 0.5s (assumed ambient noise before speech)
          execSync(
            `sox "${inputPath}" -n trim 0 0.5 noiseprof "${profilePath}"`,
            { stdio: 'pipe', timeout: 10000 }
          );
          // Apply noise reduction (0.21 = moderate reduction to avoid artifacts)
          execSync(
            `sox "${inputPath}" "${denoisedPath}" noisered "${profilePath}" 0.21`,
            { stdio: 'pipe', timeout: 10000 }
          );
          inputPath = denoisedPath;
          console.log('[recorder] Noise reduction applied');
        } catch (nrErr) {
          console.warn('[recorder] Noise reduction failed, continuing without:', (nrErr as Error).message);
        } finally {
          try { if (fs.existsSync(profilePath)) fs.unlinkSync(profilePath); } catch { /* ignore */ }
        }
      }

      // Step 2: Gain, compression, bandpass, and normalization
      const effects: string[] = [];

      if (whisperMode) {
        // Aggressive gain + compander to bring up whispered speech
        effects.push('gain 20');
        effects.push('compand 0.02,0.20 -60,-60,-30,-10,-20,-8,-5,-2 -8');
        effects.push('highpass 100');
        effects.push('lowpass 4000');
      } else {
        effects.push('gain 10');
        effects.push('highpass 200');
        effects.push('lowpass 3500');
      }
      effects.push('norm -1');

      execSync(
        `sox "${inputPath}" "${processedPath}" ${effects.join(' ')}`,
        { stdio: 'pipe', timeout: 10000 }
      );

      // Clean up intermediate denoised file
      const denoisedPath = wavPath.replace('.wav', '-denoised.wav');
      try { if (inputPath === denoisedPath && fs.existsSync(denoisedPath)) fs.unlinkSync(denoisedPath); } catch { /* ignore */ }

      const orig = fs.statSync(wavPath).size;
      const proc = fs.statSync(processedPath).size;
      console.log(`[recorder] Cleaned: ${(orig/1024).toFixed(0)}KB → ${(proc/1024).toFixed(0)}KB (noise_red=${noiseReduction}, whisper=${whisperMode})`);
      return processedPath;
    } catch (err) {
      console.warn('[recorder] Post-processing failed, using original:', (err as Error).message);
      return wavPath;
    }
  }

  /**
   * EXPERIMENT: re-encode the cleaned WAV to a smaller format before uploading
   * to a cloud STT engine. At 16kHz mono, WAV is ~32KB/s of uncompressed PCM;
   * FLAC is lossless (~half the bytes, identical transcription), OGG/Opus are
   * lossy but far smaller. Controlled by ECHO_STT_UPLOAD_FORMAT (wav|flac|ogg|opus),
   * default `flac` on this branch. Set to `wav` to reproduce the current
   * (online) behavior for an apples-to-apples comparison.
   *
   * Logs the size reduction and encode time so the upload saving can be
   * weighed against the local CPU cost. Falls back to the original WAV on any
   * failure.
   */
  static encodeForUpload(wavPath: string): string {
    const fmt = (process.env.ECHO_STT_UPLOAD_FORMAT || 'flac').toLowerCase();
    if (fmt === 'wav') return wavPath;
    if (!['flac', 'ogg', 'opus'].includes(fmt)) {
      console.warn(`[recorder] Unknown ECHO_STT_UPLOAD_FORMAT="${fmt}", uploading wav`);
      return wavPath;
    }

    const outPath = wavPath.replace(/\.wav$/, `.${fmt}`);
    try {
      // FLAC: -C 8 = max lossless compression (still ms-fast at this size).
      // OGG (Vorbis): -C 4 ≈ quality 4, small + fine for speech.
      const enc = fmt === 'flac' ? '-C 8' : fmt === 'ogg' ? '-C 4' : '';
      const t0 = Date.now();
      execSync(`sox "${wavPath}" ${enc} "${outPath}"`, { stdio: 'pipe', timeout: 10000 });
      const before = fs.statSync(wavPath).size;
      const after = fs.statSync(outPath).size;
      console.log(
        `[recorder] Upload encode ${fmt}: ${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB ` +
        `(-${(100 * (1 - after / before)).toFixed(0)}%, ${Date.now() - t0}ms)`,
      );
      return outPath;
    } catch (err) {
      console.warn(`[recorder] Upload encode to ${fmt} failed, using wav:`, (err as Error).message);
      return wavPath;
    }
  }

  /**
   * Clean up the recorded file.
   */
  cleanup(): void {
    if (this.outputPath && fs.existsSync(this.outputPath)) {
      fs.unlinkSync(this.outputPath);
      console.log(`[recorder] Cleaned up ${this.outputPath}`);
    }
  }

  /**
   * List available audio input devices using macOS system_profiler.
   */
  static listInputDevices(): string[] {
    try {
      const output = execSync(
        `system_profiler SPAudioDataType 2>/dev/null | grep "Input Source:" | sed 's/.*Input Source: //'`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      const devices = output.split('\n').map(d => d.trim()).filter(Boolean);
      // Also try to get CoreAudio device names
      try {
        const coreAudio = execSync(
          `osascript -e 'do shell script "system_profiler SPAudioDataType"' 2>/dev/null`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        // Extract device names
        const matches = coreAudio.match(/Device Name: .+/g);
        if (matches) {
          for (const m of matches) {
            const name = m.replace('Device Name: ', '').trim();
            if (name && !devices.includes(name)) devices.push(name);
          }
        }
      } catch { /* ignore */ }
      return devices;
    } catch {
      return [];
    }
  }

  /**
   * Check if sox is installed.
   */
  static checkDependencies(): { ok: boolean; message: string } {
    try {
      execSync('which rec', { stdio: 'pipe' });
      return { ok: true, message: 'sox is installed' };
    } catch {
      return {
        ok: false,
        message: 'sox is not installed. Run: brew install sox',
      };
    }
  }
}
