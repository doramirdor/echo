import { describe, it, expect } from 'vitest';
import { sanitizeRefinedOutput, buildSystemPrompt } from '../src/main/refinement/refiner';

describe('sanitizeRefinedOutput', () => {
  it('strips wrapping double quotes', () => {
    expect(sanitizeRefinedOutput('"hello world"')).toBe('hello world');
  });

  it('strips wrapping single quotes', () => {
    expect(sanitizeRefinedOutput("'hello world'")).toBe('hello world');
  });

  it('handles EMPTY sentinel', () => {
    expect(sanitizeRefinedOutput('EMPTY')).toBe('EMPTY');
  });

  it('strips LLM preambles', () => {
    expect(sanitizeRefinedOutput("Here's the cleaned transcript: hello")).toBe('hello');
  });

  it('trims whitespace', () => {
    expect(sanitizeRefinedOutput('  hello  ')).toBe('hello');
  });
});

describe('buildSystemPrompt', () => {
  it('uses default prompt when no custom prompt', () => {
    const prompt = buildSystemPrompt('');
    expect(prompt).toContain('transcription refinement');
  });

  it('includes vocabulary list', () => {
    const prompt = buildSystemPrompt('', { vocabularyList: 'Echo\nTypeScript' });
    expect(prompt).toContain('Echo');
    expect(prompt).toContain('TypeScript');
  });

  it('includes memory formatted entries', () => {
    const prompt = buildSystemPrompt('- "React" - JavaScript library');
    expect(prompt).toContain('React');
  });

  it('uses custom prompt when provided', () => {
    const prompt = buildSystemPrompt('', { customPrompt: 'Custom prompt here' });
    expect(prompt).toContain('Custom prompt here');
  });
});
