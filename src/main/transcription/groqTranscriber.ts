import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export class GroqTranscriber {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Validate a Groq API key by hitting the /models endpoint.
   */
  static async validateApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/models', {
        signal: AbortSignal.timeout(10000),
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (response.ok) return { valid: true };
      return { valid: false, error: `HTTP ${response.status}` };
    } catch (err) {
      return { valid: false, error: (err as Error).message };
    }
  }

  /**
   * Fallback transcription using curl --http2 when fetch fails.
   */
  private transcribeWithCurl(wavPath: string, opts?: { prompt?: string; language?: string }): string {
    console.log('[groq] Falling back to curl --http2');
    const lang = opts?.language?.trim() || 'en';
    const args = [
      '--silent', '--show-error', '--fail',
      '--http2',
      '--max-time', '20',
      '-X', 'POST',
      'https://api.groq.com/openai/v1/audio/transcriptions',
      '-H', `Authorization: Bearer ${this.apiKey}`,
      '-F', `file=@${wavPath}`,
      '-F', 'model=whisper-large-v3-turbo',
      '-F', 'temperature=0',
      '-F', 'response_format=verbose_json',
    ];
    if (lang !== 'auto') args.push('-F', `language=${lang}`);
    if (opts?.prompt?.trim()) args.push('-F', `prompt=${opts.prompt.trim()}`);

    const result = execFileSync('curl', args, { encoding: 'utf-8', timeout: 25000 });

    const data = JSON.parse(result) as { text: string };
    return data.text.trim();
  }

  /**
   * @param opts.prompt   Vocabulary-biasing initial prompt (jargon/accent).
   * @param opts.language ISO code or 'auto'.
   */
  async transcribe(wavPath: string, opts?: { prompt?: string; language?: string }): Promise<string> {
    const fileBuffer = fs.readFileSync(wavPath);
    const fileName = path.basename(wavPath);

    // Content type follows the upload extension (FLAC/OGG/Opus experiment).
    const ext = path.extname(wavPath).toLowerCase();
    const contentType =
      ext === '.flac' ? 'audio/flac' :
      ext === '.ogg' ? 'audio/ogg' :
      ext === '.opus' ? 'audio/opus' :
      'audio/wav';
    console.log(`[groq] Uploading ${(fileBuffer.length / 1024).toFixed(0)}KB (${contentType})`);

    // Build multipart form data manually
    const boundary = '----EchoBoundary' + Date.now();
    const parts: Buffer[] = [];

    // file field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`
    ));
    parts.push(fileBuffer);
    parts.push(Buffer.from('\r\n'));

    // model field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo\r\n`
    ));

    // language field (omit when auto-detecting)
    const lang = opts?.language?.trim() || 'en';
    if (lang !== 'auto') {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${lang}\r\n`
      ));
    }

    // prompt field — biases recognition toward the user's jargon/vocabulary
    if (opts?.prompt?.trim()) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${opts.prompt.trim()}\r\n`
      ));
    }

    // temperature
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="temperature"\r\n\r\n0\r\n`
    ));

    // response format
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`
    ));

    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const t0 = Date.now();
    let response: Response;
    try {
      response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        signal: AbortSignal.timeout(20000),
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
    } catch (fetchErr) {
      // Network or timeout error — try curl HTTP/2 fallback
      console.warn('[groq] Fetch error, trying curl fallback:', (fetchErr as Error).message);
      const text = this.transcribeWithCurl(wavPath, opts);
      console.log(`[groq] Transcribed via curl in ${Date.now() - t0}ms: "${text}"`);
      return text;
    }

    if (!response.ok) {
      const err = await response.text();
      console.warn(`[groq] Fetch failed (${response.status}), trying curl fallback`);
      try {
        return this.transcribeWithCurl(wavPath, opts);
      } catch {
        throw new Error(`Groq API error ${response.status}: ${err}`);
      }
    }

    const data = await response.json() as { text: string; language?: string; duration?: number };
    const text = data.text.trim();
    console.log(`[groq] Transcribed in ${Date.now() - t0}ms (lang=${data.language}, dur=${data.duration}s): "${text}"`);
    return text;
  }
}
