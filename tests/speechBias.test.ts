import { describe, it, expect } from 'vitest';
import { buildSpeechBiasPrompt, extractIdentifiers } from '../src/main/transcription/speechBias';
import { MemoryEntry } from '../src/main/memory/memoryEntry';

function entry(term: string): MemoryEntry {
  return {
    id: term,
    term,
    context: '',
    misrecognitions: [],
    category: 'technicalTerm',
    useCount: 0,
    createdAt: '',
    updatedAt: '',
  };
}

describe('extractIdentifiers', () => {
  it('finds camelCase, PascalCase, snake_case, acronyms, and dotted names', () => {
    const ids = extractIdentifiers('We use runPipeline, EchoState, run_log, the API, and config.json here.');
    expect(ids).toContain('runPipeline');
    expect(ids).toContain('EchoState');
    expect(ids).toContain('run_log');
    expect(ids).toContain('API');
    expect(ids).toContain('config.json');
  });

  it('skips plain english words', () => {
    const ids = extractIdentifiers('the quick brown fox jumps over the lazy dog');
    expect(ids).toHaveLength(0);
  });

  it('captures quoted/backticked tokens', () => {
    const ids = extractIdentifiers('Call `transcribe` then "GroqTranscriber".');
    expect(ids).toContain('transcribe');
    expect(ids).toContain('GroqTranscriber');
  });
});

describe('buildSpeechBiasPrompt', () => {
  it('returns empty string with no input', () => {
    expect(buildSpeechBiasPrompt({})).toBe('');
  });

  it('includes vocabulary, memory terms, and project jargon', () => {
    const prompt = buildSpeechBiasPrompt({
      vocabularyList: 'Kubernetes\nGraphQL',
      memoryEntries: [entry('Anthropic')],
      projectContext: 'The runPipeline function calls GroqTranscriber.',
    });
    expect(prompt).toContain('Kubernetes');
    expect(prompt).toContain('GraphQL');
    expect(prompt).toContain('Anthropic');
    expect(prompt).toContain('runPipeline');
    expect(prompt.startsWith('Vocabulary:')).toBe(true);
  });

  it('deduplicates terms case-insensitively', () => {
    const prompt = buildSpeechBiasPrompt({
      vocabularyList: 'Echo',
      memoryEntries: [entry('echo')],
    });
    // "Echo" appears once after "Vocabulary: "
    const matches = prompt.match(/echo/gi) || [];
    expect(matches.length).toBe(1);
  });

  it('caps length to the token window', () => {
    const many = Array.from({ length: 500 }, (_, i) => `term_${i}`).join('\n');
    const prompt = buildSpeechBiasPrompt({ vocabularyList: many });
    expect(prompt.length).toBeLessThanOrEqual(901);
  });
});
