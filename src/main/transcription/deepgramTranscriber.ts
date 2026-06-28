import * as fs from 'fs';
import { getSetting } from '../settings/settings';

export interface TranscriptionSegment {
  text: string;
  confidence: number;
  start: number;
  end: number;
}

export interface TranscriptionResult {
  text: string;
  segments: TranscriptionSegment[];
  language?: string;
}

export class DeepgramTranscriber {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  static async validateApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await fetch('https://api.deepgram.com/v1/projects', {
        signal: AbortSignal.timeout(10000),
        headers: { 'Authorization': `Token ${apiKey}` },
      });
      if (response.ok) return { valid: true };
      return { valid: false, error: `HTTP ${response.status}` };
    } catch (err) {
      return { valid: false, error: (err as Error).message };
    }
  }

  async transcribe(wavPath: string): Promise<string> {
    const result = await this.transcribeWithConfidence(wavPath);
    return result.text;
  }

  async transcribeWithConfidence(wavPath: string): Promise<TranscriptionResult> {
    const fileBuffer = fs.readFileSync(wavPath);
    const language = getSetting('transcriptionLanguage');
    const langParam = language && language !== 'auto' ? `&language=${language}` : '';

    const response = await fetch(
      `https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true${langParam}`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(30000),
        headers: {
          'Authorization': `Token ${this.apiKey}`,
          'Content-Type': 'audio/wav',
        },
        body: fileBuffer,
      },
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Deepgram API error ${response.status}: ${err}`);
    }

    const data = await response.json() as {
      results?: {
        channels?: Array<{
          alternatives?: Array<{
            transcript?: string;
            confidence?: number;
            words?: Array<{ word: string; confidence: number; start: number; end: number }>;
          }>;
        }>;
      };
    };

    const alt = data.results?.channels?.[0]?.alternatives?.[0];
    const text = alt?.transcript?.trim() ?? '';
    const segments: TranscriptionSegment[] = (alt?.words ?? []).map(w => ({
      text: w.word,
      confidence: w.confidence,
      start: w.start,
      end: w.end,
    }));

    return { text, segments, language };
  }
}
