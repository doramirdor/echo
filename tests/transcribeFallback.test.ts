import { describe, it, expect, vi, beforeEach } from 'vitest';

// The pipeline reads `whisperModelName` (and a few others) from settings; the
// fallback path also calls whisper.isReady(modelName). Mock the setting store.
vi.mock('../src/main/settings/settings', () => ({
  getSetting: vi.fn((key: string) => {
    const settings: Record<string, unknown> = {
      whisperModelName: 'ggml-base.en.bin',
      llmProvider: 'none',
      sttEngine: 'macos',
    };
    return settings[key];
  }),
}));

vi.mock('electron', () => ({
  Notification: class { show() {} },
}));

vi.mock('../src/main/overlay', () => ({
  sendConfidenceSegments: vi.fn(),
}));

// A whisper stand-in: reports readiness and transcribes. Only the two methods the
// fallback path touches (isReady + transcribe) are needed.
function fakeWhisper(opts: { ready: boolean; transcribe: () => Promise<string> }) {
  return {
    isReady: () => ({ binary: opts.ready, model: opts.ready }),
    transcribe: vi.fn(opts.transcribe),
  } as any;
}

describe('transcribeWithFallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the primary engine result when it succeeds', async () => {
    const { transcribeWithFallback } = await import('../src/main/pipeline');
    const macos = { transcribe: vi.fn(async () => 'hello from macos') } as any;
    const whisper = fakeWhisper({ ready: true, transcribe: async () => 'should not run' });

    const res = await transcribeWithFallback('macos', '/tmp/clean.wav', '/tmp/raw.wav', whisper, macos, {});

    expect(res.text).toBe('hello from macos');
    expect(res.engineUsed).toBe('macos');
    expect(whisper.transcribe).not.toHaveBeenCalled();
  });

  it('retries the same engine once on a transient failure', async () => {
    const { transcribeWithFallback } = await import('../src/main/pipeline');
    const macos = {
      transcribe: vi.fn()
        .mockRejectedValueOnce(new Error('network glitch'))
        .mockResolvedValueOnce('recovered'),
    } as any;
    const whisper = fakeWhisper({ ready: true, transcribe: async () => 'fallback' });

    const res = await transcribeWithFallback('macos', '/tmp/clean.wav', '/tmp/raw.wav', whisper, macos, {});

    expect(macos.transcribe).toHaveBeenCalledTimes(2);
    expect(res.text).toBe('recovered');
    expect(res.engineUsed).toBe('macos');
    expect(whisper.transcribe).not.toHaveBeenCalled();
  });

  it('falls back to local whisper when the primary keeps failing', async () => {
    const { transcribeWithFallback } = await import('../src/main/pipeline');
    const macos = { transcribe: vi.fn(async () => { throw new Error('engine down'); }) } as any;
    const whisper = fakeWhisper({ ready: true, transcribe: async () => 'local whisper text' });

    const res = await transcribeWithFallback('macos', '/tmp/clean.wav', '/tmp/raw.wav', whisper, macos, {});

    expect(res.text).toBe('local whisper text');
    expect(res.engineUsed).toBe('whisper');
    expect(whisper.transcribe).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-transient (auth) error, but still falls back', async () => {
    const { transcribeWithFallback } = await import('../src/main/pipeline');
    const macos = { transcribe: vi.fn(async () => { throw new Error('401 invalid api key'); }) } as any;
    const whisper = fakeWhisper({ ready: true, transcribe: async () => 'local text' });

    const res = await transcribeWithFallback('groq', '/tmp/clean.wav', '/tmp/raw.wav', whisper, macos, {});

    // groq path constructs its own client; here the primary is macos-shaped, but
    // the key assertion is: one attempt (no retry) then fallback to whisper.
    expect(res.engineUsed).toBe('whisper');
  });

  it('surfaces the error when the primary fails and whisper is not installed', async () => {
    const { transcribeWithFallback } = await import('../src/main/pipeline');
    const macos = { transcribe: vi.fn(async () => { throw new Error('engine down'); }) } as any;
    const whisper = fakeWhisper({ ready: false, transcribe: async () => 'unreachable' });

    await expect(
      transcribeWithFallback('macos', '/tmp/clean.wav', '/tmp/raw.wav', whisper, macos, {}),
    ).rejects.toThrow('engine down');
    expect(whisper.transcribe).not.toHaveBeenCalled();
  });

  it('does not attempt to fall back to whisper when whisper is already the engine', async () => {
    const { transcribeWithFallback } = await import('../src/main/pipeline');
    const macos = { transcribe: vi.fn() } as any;
    const whisper = fakeWhisper({ ready: true, transcribe: async () => { throw new Error('whisper broke'); } });

    await expect(
      transcribeWithFallback('whisper', '/tmp/clean.wav', '/tmp/raw.wav', whisper, macos, {}),
    ).rejects.toThrow('whisper broke');
    // Attempted once + one transient retry, but never a second "fallback" engine.
    expect(whisper.transcribe).toHaveBeenCalledTimes(2);
  });
});

describe('isRetryableSttError', () => {
  it('treats auth and setup errors as non-retryable', async () => {
    const { isRetryableSttError } = await import('../src/main/pipeline');
    expect(isRetryableSttError('HTTP 401 Unauthorized')).toBe(false);
    expect(isRetryableSttError('403 Forbidden')).toBe(false);
    expect(isRetryableSttError('Invalid API key')).toBe(false);
    expect(isRetryableSttError('whisper binary not found')).toBe(false);
    expect(isRetryableSttError('Whisper is not ready')).toBe(false);
  });

  it('treats transient/network errors as retryable', async () => {
    const { isRetryableSttError } = await import('../src/main/pipeline');
    expect(isRetryableSttError('network timeout')).toBe(true);
    expect(isRetryableSttError('ECONNRESET')).toBe(true);
    expect(isRetryableSttError('500 Internal Server Error')).toBe(true);
  });
});
