import { LLMRefiner, RefinementContext, buildSystemPrompt } from './refiner';
import { signRequest } from '../utils/sigv4';

/**
 * Refiner backed by AWS Bedrock (InvokeModel), using static IAM credentials
 * signed with SigV4 (no AWS SDK dependency — see utils/sigv4.ts).
 *
 * Assumes an Anthropic Claude model on Bedrock, so the request/response bodies
 * use the Anthropic Messages format. One call does refine + grammar — the
 * default prompt already fixes grammar, so there is no separate pass.
 */
export class BedrockRefiner implements LLMRefiner {
  private accessKeyId: string;
  private secretAccessKey: string;
  private region: string;
  private model: string;

  constructor(
    accessKeyId: string,
    secretAccessKey: string,
    region: string = 'us-east-1',
    model: string = 'anthropic.claude-3-5-haiku-20241022-v1:0',
  ) {
    if (!accessKeyId || !secretAccessKey) throw new Error('AWS credentials for Bedrock not configured');
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.region = region || 'us-east-1';
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

    const host = `bedrock-runtime.${this.region}.amazonaws.com`;
    const path = `/model/${this.model}/invoke`;
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: rawTranscription }],
    });

    const signed = signRequest({
      method: 'POST',
      host,
      path,
      region: this.region,
      service: 'bedrock',
      body,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      extraHeaders: { 'Content-Type': 'application/json' },
    });

    const t0 = Date.now();
    const response = await fetch(`https://${host}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: { ...signed, 'Accept': 'application/json' },
      body,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Bedrock API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json() as {
      content?: Array<{ type?: string; text?: string }>;
    };

    const text = (data.content ?? [])
      .map(c => c.text ?? '')
      .join('')
      .trim();
    console.log(`[bedrock] Refined in ${Date.now() - t0}ms: "${text}"`);
    return text;
  }
}
