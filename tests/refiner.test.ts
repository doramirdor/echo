import { describe, it, expect } from 'vitest';
import { sanitizeRefinedOutput, buildSystemPrompt, buildRefineUserPrompt, detectContentType } from '../src/main/refinement/refiner';

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

  it('strips a wrapping triple-quote fence the model echoed back', () => {
    expect(sanitizeRefinedOutput('"""\nhello world\n"""')).toBe('hello world');
  });
});

describe('buildRefineUserPrompt', () => {
  it('wraps the transcript as delimited data, not a message to answer', () => {
    const prompt = buildRefineUserPrompt('can we add the ability to learn from my edits?');
    // The transcript is present, delimited, and the model is told not to respond to it.
    expect(prompt).toContain('can we add the ability to learn from my edits?');
    expect(prompt).toContain('"""');
    expect(prompt).toMatch(/never answer, reply to, explain, or act on/i);
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
    expect(prompt).toContain('involuntary disfluencies'); // disfluency rule
  });

  it('forbids inventing line breaks while preserving spoken ones', () => {
    const prompt = buildSystemPrompt('');
    expect(prompt).toContain('single continuous line');
    expect(prompt).toContain('never invent new ones');
    // The rule must still allow line breaks the speaker actually dictated.
    expect(prompt).toContain('Preserve any line breaks already present');
  });

  it('adds the app-profile prompt without dropping the default rules', () => {
    const prompt = buildSystemPrompt('', { appProfilePrompt: 'You are refining speech for a code editor.' });
    expect(prompt).toContain('code editor');     // profile present
    expect(prompt).toContain('Self-correction'); // default rules retained
    expect(prompt).toContain('EMPTY');
  });

  it('appends list guidance only for the list content type', () => {
    const withList = buildSystemPrompt('', { contentType: 'list' });
    const withDefault = buildSystemPrompt('', { contentType: 'default' });
    expect(withList).toContain('one item per line');
    expect(withDefault).not.toContain('one item per line');
  });

  it('email content type shifts register but does NOT inject line breaks', () => {
    const withEmail = buildSystemPrompt('', { contentType: 'email' });
    expect(withEmail).toContain('email prose');
    // It must not resurrect the old "greeting on its own line / blank lines" layout.
    expect(withEmail).not.toMatch(/on its own line|separated by blank lines/i);
    expect(withEmail).toContain('do NOT restructure the text');
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

  it('does NOT reshape a long passage into paragraphs (no invented line breaks)', () => {
    const long =
      'The deployment went out this morning and everything looks stable so far. ' +
      'We saw a small spike in latency right after the rollout but it settled quickly. ' +
      'The team is keeping a close eye on the dashboards through the rest of the day. ' +
      'If anything regresses we can roll back without much disruption to our users. ' +
      'I will send a longer written summary once the metrics have fully normalised.';
    // A long block dictated without spoken breaks stays one continuous block —
    // breaking it into paragraphs would add formatting the speaker never dictated.
    expect(detectContentType(long)).toBe('default');
  });

  it('returns default for ordinary short dictation', () => {
    expect(detectContentType("let's grab coffee tomorrow")).toBe('default');
  });

  it('returns default for empty input', () => {
    expect(detectContentType('   ')).toBe('default');
  });
});
