import { describe, it, expect } from 'vitest';
import { sanitizeRefinedOutput, buildSystemPrompt, detectContentType } from '../src/main/refinement/refiner';

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

  it('keeps the Wispr-parity rules in the default prompt', () => {
    const prompt = buildSystemPrompt('');
    expect(prompt).toContain("Preserve the speaker's own voice");
    expect(prompt).toContain('Self-correction handling');
    expect(prompt).toContain('repeated words'); // disfluency rule
  });

  it('adds the app-profile prompt without dropping the default rules', () => {
    const prompt = buildSystemPrompt('', { appProfilePrompt: 'You are refining speech for a code editor.' });
    expect(prompt).toContain('code editor');     // profile present
    expect(prompt).toContain('Self-correction'); // default rules retained
    expect(prompt).toContain('EMPTY');
  });

  it('appends formatting guidance only for a non-default content type', () => {
    const withList = buildSystemPrompt('', { contentType: 'list' });
    const withDefault = buildSystemPrompt('', { contentType: 'default' });
    expect(withList).toContain('overrides the "no formatting" rule');
    expect(withDefault).not.toContain('overrides the "no formatting" rule');
  });
});

describe('detectContentType', () => {
  it('detects a list from ordinal enumeration', () => {
    expect(detectContentType('First buy milk second walk the dog third call mom')).toBe('list');
  });

  it('detects a list from an explicit cue', () => {
    expect(detectContentType('here are the things we need to do today')).toBe('list');
  });

  it('detects an email from greeting and sign-off', () => {
    expect(detectContentType('Hi Sarah, thanks for the update. Best regards, Dor')).toBe('email');
  });

  it('detects a long multi-sentence passage as paragraph', () => {
    const long =
      'The deployment went out this morning and everything looks stable so far. ' +
      'We saw a small spike in latency right after the rollout but it settled quickly. ' +
      'The team is keeping a close eye on the dashboards through the rest of the day. ' +
      'If anything regresses we can roll back without much disruption to our users. ' +
      'I will send a longer written summary once the metrics have fully normalised.';
    expect(detectContentType(long)).toBe('paragraph');
  });

  it('returns default for ordinary short dictation', () => {
    expect(detectContentType("let's grab coffee tomorrow")).toBe('default');
  });

  it('returns default for empty input', () => {
    expect(detectContentType('   ')).toBe('default');
  });
});
