import { LLMRefiner, RefinementContext, buildSystemPrompt } from './refiner';

/**
 * Local LLM refinement via llama.cpp server (OpenAI-compatible API).
 */
export class LlamaLocalRefiner implements LLMRefiner {
  private endpoint: string;
  private model: string;

  constructor(endpoint: string, model: string) {
    this.endpoint = endpoint.replace(/\/$/, '');
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

    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(60000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: rawTranscription },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Llama local API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    const text = data.choices[0]?.message?.content?.trim() ?? '';
    console.log(`[llama-local] Refined: "${text}"`);
    return text;
  }
}
