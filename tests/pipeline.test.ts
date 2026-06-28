import { describe, it, expect, vi } from 'vitest';

// Mock all heavy dependencies
vi.mock('../src/main/settings/settings', () => ({
  getSetting: vi.fn((key: string) => {
    const settings: Record<string, unknown> = {
      llmProvider: 'none',
      sttEngine: 'whisper',
      grammarCheck: false,
      voiceCommandsEnabled: true,
      useWindowContext: false,
      vocabularyList: '',
      customPrompt: '',
      whisperModelName: 'ggml-small.en.bin',
      dictationHistoryContext: 0,
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

describe('pipeline createRefiner', () => {
  it('returns null for none provider', async () => {
    const { createRefiner } = await import('../src/main/pipeline');
    expect(createRefiner()).toBeNull();
  });
});
