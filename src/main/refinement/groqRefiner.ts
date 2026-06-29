import { LLMRefiner, RefinementContext, buildSystemPrompt } from './refiner';

/**
 * Refiner backed by Groq's OpenAI-compatible chat endpoint.
 *
 * Groq has no single audio→instructed-text endpoint, so transcription and
 * refinement are two calls; this is the second. We keep it to ONE LLM call by
 * relying on the default refine prompt, which already fixes grammar,
 * punctuation, and spelling — there is no separate grammar pass to make.
 *
 * Default model is `llama-3.1-8b-instant`: lowest time-to-first-token on Groq,
 * which is what dominates time-to-first-insertion for short dictations.
 */
export class GroqRefiner implements LLMRefiner {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = 'llama-3.1-8b-instant') {
    if (!apiKey) throw new Error('Groq API key not configured');
    this.apiKey = apiKey;
    this.model = model;
  }

  async refine(rawTranscription: string, context: RefinementContext): Promise<string> {
    const systemPrompt = buildSystemPrompt(context.memoryFormatted, {
      appProfilePrompt: context.appProfilePrompt,
      contentType: context.contentType,
      customPrompt: context.customPrompt,
      windowContext: context.windowContext,
      vocabularyList: context.vocabularyList,
      existingFieldText: context.existingFieldText,
      existingFieldTextAfter: context.existingFieldTextAfter,
      projectContext: context.projectContext,
      tone: context.tone,
    });

    const t0 = Date.now();
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: rawTranscription },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Groq API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    const text = data.choices[0]?.message?.content?.trim() ?? '';
    console.log(`[groq-llm] Refined in ${Date.now() - t0}ms: "${text}"`);
    return text;
  }
}
