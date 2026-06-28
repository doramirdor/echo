import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';

vi.mock('electron', () => ({
  app: {
    getPath: () => path.join(os.tmpdir(), 'echo-test-' + Date.now()),
  },
}));

import { RunLog } from '../src/main/history/runLog';

describe('RunLog', () => {
  let runLog: RunLog;

  beforeEach(() => {
    runLog = new RunLog();
  });

  it('adds entries', () => {
    const entry = runLog.add({
      rawTranscription: 'hello',
      refinedText: 'Hello.',
      context: '',
      sttEngine: 'whisper',
      llmProvider: 'none',
      durationMs: 100,
    });
    expect(entry.id).toBeTruthy();
    expect(entry.timestamp).toBeTruthy();
  });

  it('caps at MAX_ENTRIES', () => {
    for (let i = 0; i < 110; i++) {
      runLog.add({
        rawTranscription: `text ${i}`,
        refinedText: `Text ${i}.`,
        context: '',
        sttEngine: 'whisper',
        llmProvider: 'none',
        durationMs: 50,
      });
    }
    expect(runLog.getAll().length).toBeLessThanOrEqual(100);
  });

  it('searches entries', () => {
    runLog.add({
      rawTranscription: 'react component',
      refinedText: 'React component.',
      context: '',
      sttEngine: 'whisper',
      llmProvider: 'claude-cli',
      durationMs: 200,
    });
    runLog.add({
      rawTranscription: 'hello world',
      refinedText: 'Hello world.',
      context: '',
      sttEngine: 'groq',
      llmProvider: 'none',
      durationMs: 100,
    });

    const results = runLog.search('react');
    expect(results.length).toBe(1);
    expect(results[0].refinedText).toContain('React');
  });

  it('clears all entries', () => {
    runLog.add({
      rawTranscription: 'test',
      refinedText: 'Test.',
      context: '',
      sttEngine: 'whisper',
      llmProvider: 'none',
      durationMs: 50,
    });
    runLog.clear();
    expect(runLog.getAll().length).toBe(0);
  });
});
