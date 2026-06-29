import { LLMRefiner, RefinementContext, buildSystemPrompt } from './refiner';

export class OpenAIRefiner implements LLMRefiner {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = 'gpt-4o-mini') {
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

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
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
      throw new Error(`OpenAI API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    const text = data.choices[0]?.message?.content?.trim() ?? '';
    console.log(`[openai] Refined: "${text}"`);
    return text;
  }
}
