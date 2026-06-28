import { describe, it, expect, vi, afterEach } from 'vitest';
import { GroqRefiner } from '../src/main/refinement/groqRefiner';

describe('GroqRefiner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when no API key is configured', () => {
    expect(() => new GroqRefiner('')).toThrow(/Groq API key/);
  });

  it('posts a single chat completion to Groq and returns the trimmed content', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '  Hello world.  ' } }] }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const refiner = new GroqRefiner('test-key', 'llama-3.1-8b-instant');
    const out = await refiner.refine('hello world', { memoryEntries: [], memoryFormatted: '' });

    expect(out).toBe('Hello world.');
    expect(fetchMock).toHaveBeenCalledTimes(1); // one call covers refine + grammar
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('llama-3.1-8b-instant');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hello world' });
  });
});
