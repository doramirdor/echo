import * as fs from 'fs';
import * as path from 'path';
import { getSetting } from '../settings/settings';
import { TranscriptionResult, TranscriptionSegment } from './deepgramTranscriber';

export class OpenAIWhisperTranscriber {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? 'whisper-1';
  }

  static async validateApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        signal: AbortSignal.timeout(10000),
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (response.ok) return { valid: true };
      return { valid: false, error: `HTTP ${response.status}` };
    } catch (err) {
      return { valid: false, error: (err as Error).message };
    }
  }

  async transcribe(wavPath: string, opts?: { prompt?: string }): Promise<string> {
    const result = await this.transcribeWithConfidence(wavPath, opts);
    return result.text;
  }

  /**
   * @param opts.prompt  Vocabulary-biasing initial prompt (jargon/accent).
   */
  async transcribeWithConfidence(wavPath: string, opts?: { prompt?: string }): Promise<TranscriptionResult> {
    const fileBuffer = fs.readFileSync(wavPath);
    const fileName = path.basename(wavPath);
    const language = getSetting('transcriptionLanguage');

    const boundary = '----EchoBoundary' + Date.now();
    const parts: Buffer[] = [];

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: audio/wav\r\n\r\n`,
    ));
    parts.push(fileBuffer);
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${this.model}\r\n`,
    ));
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`,
    ));
    if (language && language !== 'auto') {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`,
      ));
    }
    if (opts?.prompt?.trim()) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${opts.prompt.trim()}\r\n`,
      ));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: Buffer.concat(parts),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI Whisper API error ${response.status}: ${err}`);
    }

    const data = await response.json() as {
      text: string;
      language?: string;
      segments?: Array<{ text: string; avg_logprob?: number; start: number; end: number }>;
    };

    const segments: TranscriptionSegment[] = (data.segments ?? []).map(s => ({
      text: s.text.trim(),
      confidence: s.avg_logprob != null ? Math.exp(s.avg_logprob) : 1,
      start: s.start,
      end: s.end,
    }));

    return { text: data.text.trim(), segments, language: data.language };
  }
}
