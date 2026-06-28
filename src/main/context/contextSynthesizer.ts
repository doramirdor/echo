import { WindowContext, screenshotToBase64, screenshotMediaType, compressScreenshot } from './windowContext';

const CONTEXT_SYNTHESIS_PROMPT = `You are a context synthesis assistant for a speech-to-text dictation pipeline.

Given metadata about the user's active application and optionally a screenshot, produce exactly TWO sentences:
1. What the user is currently doing (be specific: email recipient, Slack channel, document title, terminal command, code file, etc.)
2. What their likely writing intent is (replying to a message, writing code, composing a document, entering a search query, etc.)

Prioritize concrete details visible on screen: names, email addresses, channel names, file paths, code symbols, terminal commands.

Rules:
- Output ONLY the two sentences, nothing else
- Do not speculate beyond what is visible
- If the screenshot is unclear, base your answer on the app/window metadata only
- Keep it concise — this will be injected as context for transcription cleanup`;

/**
 * Synthesizes a rich context description from window metadata and an optional screenshot.
 * Uses a vision-capable LLM to understand what the user is looking at.
 */
export async function synthesizeContext(
  windowCtx: WindowContext,
  screenshotPath?: string,
  provider: 'claude' | 'groq' = 'claude',
  apiKey?: string,
): Promise<string> {
  const metadata = [
    `Application: ${windowCtx.appName || 'Unknown'}`,
    windowCtx.bundleId ? `Bundle ID: ${windowCtx.bundleId}` : '',
    windowCtx.windowTitle ? `Window Title: ${windowCtx.windowTitle}` : '',
  ].filter(Boolean).join('\n');

  // If no screenshot and no meaningful metadata, return basic context
  if (!screenshotPath && !windowCtx.appName) {
    return '';
  }

  // If no API key available, fall back to metadata-only context
  if (!apiKey) {
    return metadataOnlyContext(windowCtx);
  }

  try {
    // Compress screenshot before sending to vision API
    let optimizedPath = screenshotPath;
    if (screenshotPath) {
      optimizedPath = await compressScreenshot(screenshotPath);
    }

    if (provider === 'claude') {
      return await synthesizeWithClaude(metadata, optimizedPath, apiKey);
    } else {
      return await synthesizeWithGroq(metadata, optimizedPath, apiKey);
    }
  } catch (err) {
    console.warn('[context-synth] Vision synthesis failed, falling back to metadata:', (err as Error).message);
    return metadataOnlyContext(windowCtx);
  }
}

function metadataOnlyContext(ctx: WindowContext): string {
  if (!ctx.appName) return '';
  const parts = [`User is in ${ctx.appName}`];
  if (ctx.windowTitle) parts[0] += ` with window "${ctx.windowTitle}"`;
  return parts[0] + '.';
}

async function synthesizeWithClaude(
  metadata: string,
  screenshotPath: string | undefined,
  apiKey: string,
): Promise<string> {
  const content: Array<{ type: string; [key: string]: unknown }> = [];

  // Add the screenshot as an image if available
  if (screenshotPath) {
    const base64 = screenshotToBase64(screenshotPath);
    const mediaType = screenshotMediaType(screenshotPath);
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: base64,
      },
    });
  }

  content.push({
    type: 'text',
    text: `Window metadata:\n${metadata}\n\nDescribe what the user is doing and their likely writing intent.`,
  });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      temperature: 0.2,
      system: CONTEXT_SYNTHESIS_PROMPT,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude vision API error ${response.status}: ${err}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
  };

  const text = data.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('')
    .trim();

  console.log(`[context-synth] Claude vision result: "${text}"`);
  return text;
}

async function synthesizeWithGroq(
  metadata: string,
  screenshotPath: string | undefined,
  apiKey: string,
): Promise<string> {
  const content: Array<{ type: string; [key: string]: unknown }> = [];

  if (screenshotPath) {
    const base64 = screenshotToBase64(screenshotPath);
    const mediaType = screenshotMediaType(screenshotPath);
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:${mediaType};base64,${base64}`,
      },
    });
  }

  content.push({
    type: 'text',
    text: `Window metadata:\n${metadata}\n\nDescribe what the user is doing and their likely writing intent.`,
  });

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'llama-4-scout-17b-16e-instruct',
      max_tokens: 200,
      temperature: 0.2,
      messages: [
        { role: 'system', content: CONTEXT_SYNTHESIS_PROMPT },
        { role: 'user', content },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq vision API error ${response.status}: ${err}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  const text = (data.choices[0]?.message?.content || '').trim();
  console.log(`[context-synth] Groq vision result: "${text}"`);
  return text;
}
