import { describe, it, expect } from 'vitest';
import { isMidSentence, needsLeadingSpace, joinContinuation } from '../src/main/insertion/continuation';

describe('isMidSentence', () => {
  it('is false for empty text', () => {
    expect(isMidSentence('')).toBe(false);
    expect(isMidSentence('   ')).toBe(false);
  });

  it('is true when text ends mid-sentence', () => {
    expect(isMidSentence('I went to the')).toBe(true);
    expect(isMidSentence('the quick brown ')).toBe(true);
  });

  it('is false after sentence-ending punctuation', () => {
    expect(isMidSentence('Hello world.')).toBe(false);
    expect(isMidSentence('Really?')).toBe(false);
    expect(isMidSentence('Stop!')).toBe(false);
    expect(isMidSentence('Note: ')).toBe(false);
  });
});

describe('needsLeadingSpace', () => {
  it('adds a space between two words', () => {
    expect(needsLeadingSpace('hello', 'world')).toBe(true);
  });

  it('does not double existing whitespace', () => {
    expect(needsLeadingSpace('hello ', 'world')).toBe(false);
  });

  it('does not space after an opening bracket/quote', () => {
    expect(needsLeadingSpace('(', 'x')).toBe(false);
    expect(needsLeadingSpace('"', 'x')).toBe(false);
  });

  it('does not space before clinging punctuation', () => {
    expect(needsLeadingSpace('hello', ', world')).toBe(false);
    expect(needsLeadingSpace('hello', '.')).toBe(false);
  });

  it('is false when there is no preceding text', () => {
    expect(needsLeadingSpace('', 'world')).toBe(false);
  });
});

describe('joinContinuation', () => {
  it('returns new text unchanged with no preceding text', () => {
    expect(joinContinuation('', 'Hello world')).toBe('Hello world');
  });

  it('continues mid-sentence: lowercases and spaces', () => {
    expect(joinContinuation('I went to the', 'Store to buy milk')).toBe(' store to buy milk');
  });

  it('starts a new sentence after a period (keeps capitalization)', () => {
    expect(joinContinuation('Done.', 'Next thing')).toBe(' Next thing');
  });

  it('preserves "I" mid-sentence', () => {
    expect(joinContinuation('and then', 'I left')).toBe(' I left');
  });

  it('preserves acronyms and identifiers mid-sentence', () => {
    expect(joinContinuation('we call the', 'API directly')).toBe(' API directly');
    expect(joinContinuation('update the', 'runPipeline function')).toBe(' runPipeline function');
  });

  it('does not add a space when one already exists', () => {
    expect(joinContinuation('hello ', 'there')).toBe('there');
  });
});
