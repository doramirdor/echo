import { describe, it, expect, vi, afterEach } from 'vitest';
import { GeminiRefiner } from '../src/main/refinement/geminiRefiner';
import { BedrockRefiner } from '../src/main/refinement/bedrockRefiner';

afterEach(() => vi.restoreAllMocks());

describe('GeminiRefiner', () => {
  it('throws without an API key', () => {
    expect(() => new GeminiRefiner('')).toThrow(/Gemini API key/);
  });

  it('calls generateContent and parses candidate parts', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: ' Hi there. ' }] } }] }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const out = await new GeminiRefiner('k', 'gemini-2.0-flash')
      .refine('hi there', { memoryEntries: [], memoryFormatted: '' });

    expect(out).toBe('Hi there.');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/models/gemini-2.0-flash:generateContent');
    expect((init as RequestInit & { headers: Record<string, string> }).headers['x-goog-api-key']).toBe('k');
  });
});

describe('BedrockRefiner', () => {
  it('throws without credentials', () => {
    expect(() => new BedrockRefiner('', '')).toThrow(/AWS credentials/);
  });

  it('signs the request (Authorization header) and parses content', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'Refined.' }] }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const out = await new BedrockRefiner('AKIDEXAMPLE', 'secret', 'us-east-1', 'anthropic.claude-3-5-haiku-20241022-v1:0')
      .refine('refine me', { memoryEntries: [], memoryFormatted: '' });

    expect(out).toBe('Refined.');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-haiku-20241022-v1:0/invoke');
    const headers = (init as RequestInit & { headers: Record<string, string> }).headers;
    expect(headers['Authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    expect(headers['Authorization']).toContain('SignedHeaders=content-type;host;x-amz-date');
  });
});
