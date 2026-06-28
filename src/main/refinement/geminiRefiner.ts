import { LLMRefiner, RefinementContext, buildSystemPrompt } from './refiner';

/**
 * Refiner backed by Google's Gemini API (generateContent).
 *
 * One call does refine + grammar — the default refine prompt already fixes
 * grammar/punctuation/spelling, so there is no separate pass. `gemini-2.0-flash`
 * is a fast, low-latency default; the model is editable in settings.
 */
export class GeminiRefiner implements LLMRefiner {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = 'gemini-2.0-flash') {
    if (!apiKey) throw new Error('Gemini API key not configured');
    this.apiKey = apiKey;
    this.model = model;
  }

  async refine(rawTranscription: string, context: RefinementContext): Promise<string> {
    const systemPrompt = buildSystemPrompt(context.memoryFormatted, {
      customPrompt: context.customPrompt,
      windowContext: context.windowContext,
      vocabularyList: context.vocabularyList,
      existingFieldText: context.existingFieldText,
      existingFieldTextAfter: context.existingFieldTextAfter,
      projectContext: context.projectContext,
      tone: context.tone,
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;

    const t0 = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: rawTranscription }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1024 },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map(p => p.text ?? '')
      .join('')
      .trim();
    console.log(`[gemini] Refined in ${Date.now() - t0}ms: "${text}"`);
    return text;
  }
}
