import { execFile } from 'child_process';
import * as fs from 'fs';
import { ensureSwiftBinary, getBinaryPath } from '../utils/swiftBinary';

const BIN_NAME = 'transcribe';

export class MacOSTranscriber {
  isReady(): boolean {
    return ensureSwiftBinary(BIN_NAME, 'scripts/transcribe.swift') && fs.existsSync(getBinaryPath(BIN_NAME));
  }

  async transcribe(wavPath: string): Promise<string> {
    if (!this.isReady()) {
      throw new Error(`macOS transcriber not found at ${getBinaryPath(BIN_NAME)}`);
    }

    const binPath = getBinaryPath(BIN_NAME);
    return new Promise((resolve, reject) => {
      execFile(binPath, [wavPath], { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          console.error('[macos-stt] stderr:', stderr);
          reject(new Error(`macOS transcription failed: ${error.message}`));
          return;
        }

        const text = stdout.trim();
        console.log(`[macos-stt] Transcribed: "${text}"`);
        resolve(text);
      });
    });
  }
}
