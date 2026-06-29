import { LLMRefiner, RefinementContext, buildSystemPrompt } from './refiner';

export class OllamaRefiner implements LLMRefiner {
  private endpoint: string;
  private model: string;

  constructor(endpoint: string = 'http://localhost:11434', model: string = 'llama3.2') {
    this.endpoint = endpoint;
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

    const response = await fetch(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: rawTranscription },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Ollama error ${response.status}: ${errorBody}`);
    }

    const data = await response.json() as {
      message: { content: string };
    };

    const text = data.message.content.trim();
    console.log(`[ollama] Refined: "${text}"`);
    return text;
  }
}
