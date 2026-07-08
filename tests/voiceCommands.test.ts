import { describe, it, expect } from 'vitest';
import { processVoiceCommands, applyCodeGrammar } from '../src/main/voice/voiceCommands';

describe('processVoiceCommands', () => {
  it('returns text unchanged when disabled', () => {
    const result = processVoiceCommands('hello new line world', false);
    expect(result.text).toBe('hello new line world');
    expect(result.commands).toEqual([]);
  });

  it('converts new line command', () => {
    const result = processVoiceCommands('hello new line world', true);
    expect(result.text).toBe('hello\nworld');
    expect(result.commands).toContain('newline');
  });

  it('converts new paragraph command', () => {
    const result = processVoiceCommands('first new paragraph second', true);
    expect(result.text).toContain('\n\n');
    expect(result.commands).toContain('newparagraph');
  });

  it('handles scratch that as skip refinement', () => {
    const result = processVoiceCommands('hello scratch that', true);
    expect(result.skipRefinement).toBe(true);
    expect(result.commands).toContain('scratch');
  });

  it('converts period command', () => {
    const result = processVoiceCommands('hello period', true);
    expect(result.text).toBe('hello .');
    expect(result.commands).toContain('period');
  });

  it('converts mid-utterance punctuation commands', () => {
    const result = processVoiceCommands('first thought period second thought', true);
    expect(result.text).toBe('first thought . second thought');
    expect(result.commands).toContain('period');
  });

  it('converts repeated comma commands in a dictated list', () => {
    const result = processVoiceCommands('add milk comma eggs comma bread', true);
    expect(result.text).toBe('add milk , eggs , bread');
    expect(result.commands).toContain('comma');
  });

  it('does NOT apply code grammar unless codeSymbols is enabled', () => {
    const result = processVoiceCommands('set snake case user id', true);
    expect(result.text).toBe('set snake case user id');
    expect(result.commands).not.toContain('code-grammar');
  });

  it('applies code grammar when codeSymbols is enabled', () => {
    const result = processVoiceCommands('const snake case user id', true, { codeSymbols: true });
    expect(result.text).toContain('user_id');
    expect(result.commands).toContain('code-grammar');
  });
});

describe('punctuation noun-context guard', () => {
  it('leaves "trial period" untouched', () => {
    const result = processVoiceCommands('the trial period ended', true);
    expect(result.text).toBe('the trial period ended');
    expect(result.commands).not.toContain('period');
  });

  it('leaves "grace period" untouched', () => {
    const result = processVoiceCommands('the grace period expires tomorrow', true);
    expect(result.text).toBe('the grace period expires tomorrow');
    expect(result.commands).not.toContain('period');
  });

  it('leaves hyphenated compounds like "comma-separated" untouched', () => {
    const result = processVoiceCommands('export it as comma-separated values', true);
    expect(result.text).toBe('export it as comma-separated values');
    expect(result.commands).not.toContain('comma');
  });

  it('leaves "a colon in the URL" untouched', () => {
    const result = processVoiceCommands('there is a colon in the URL', true);
    expect(result.text).toBe('there is a colon in the URL');
    expect(result.commands).not.toContain('colon');
  });

  it('leaves "a semicolon between clauses" untouched', () => {
    const result = processVoiceCommands('put a semicolon between clauses', true);
    expect(result.text).toBe('put a semicolon between clauses');
    expect(result.commands).not.toContain('semicolon');
  });

  it('still converts a command outside noun context', () => {
    const result = processVoiceCommands('see you tomorrow period', true);
    expect(result.text).toBe('see you tomorrow .');
    expect(result.commands).toContain('period');
  });
});

describe('scratch that / undo that', () => {
  it('deletes the whole sentence when embedded (unpunctuated)', () => {
    const result = processVoiceCommands('hello scratch that', true);
    expect(result.text).toBe('');
    expect(result.commands).toContain('scratch');
    expect(result.skipRefinement).toBe(true);
  });

  it('keeps content after an embedded scratch that', () => {
    const result = processVoiceCommands('send the report scratch that email the team', true);
    expect(result.text).toBe('email the team');
    expect(result.commands).toContain('scratch');
  });

  it('only deletes back to the previous sentence boundary when embedded', () => {
    const result = processVoiceCommands('Keep this. now delete scratch that and keep going', true);
    expect(result.text).toBe('Keep this. and keep going');
  });

  it('also deletes the previous sentence when standing alone (punctuated)', () => {
    const result = processVoiceCommands('Hello there. Scratch that. How are you?', true);
    expect(result.text).toBe('How are you?');
    expect(result.commands).toContain('scratch');
  });

  it('handles a standalone undo that at the end', () => {
    const result = processVoiceCommands('The meeting is at three. Undo that.', true);
    expect(result.text).toBe('');
    expect(result.commands).toContain('undo');
    expect(result.skipRefinement).toBe(true);
  });

  it('treats a newline as a sentence boundary', () => {
    const result = processVoiceCommands('first line\nsecond line scratch that', true);
    expect(result.text).toBe('first line');
  });

  it('passes scratch that through untouched when a refiner will run', () => {
    const result = processVoiceCommands('hello world scratch that', true, { refinerAvailable: true });
    expect(result.text).toBe('hello world scratch that');
    expect(result.commands).not.toContain('scratch');
    expect(result.skipRefinement).toBe(false);
  });

  it('passes undo that through untouched when a refiner will run', () => {
    const result = processVoiceCommands('The price is fifty. Undo that.', true, { refinerAvailable: true });
    expect(result.text).toBe('The price is fifty. Undo that.');
    expect(result.commands).not.toContain('undo');
    expect(result.skipRefinement).toBe(false);
  });

  it('still applies punctuation commands when a refiner will run', () => {
    const result = processVoiceCommands('hello period', true, { refinerAvailable: true });
    expect(result.text).toBe('hello .');
    expect(result.commands).toContain('period');
  });
});

describe('applyCodeGrammar', () => {
  it('converts spoken brackets and braces', () => {
    expect(applyCodeGrammar('open brace close brace')).toBe('{ }');
    expect(applyCodeGrammar('open bracket close bracket')).toBe('[ ]');
  });

  it('converts arrows and equality operators', () => {
    expect(applyCodeGrammar('fat arrow')).toBe('=>');
    expect(applyCodeGrammar('thin arrow')).toBe('->');
    expect(applyCodeGrammar('triple equals')).toBe('===');
    expect(applyCodeGrammar('double equals')).toBe('==');
    expect(applyCodeGrammar('not equal')).toBe('!=');
  });

  it('requires a disambiguating suffix for prose-risky symbols', () => {
    // Bare words stay as prose...
    expect(applyCodeGrammar('meet me at the hash of things')).toBe('meet me at the hash of things');
    // ...but the explicit symbol form converts.
    expect(applyCodeGrammar('hash sign')).toBe('#');
    expect(applyCodeGrammar('at sign')).toBe('@');
    expect(applyCodeGrammar('dollar sign')).toBe('$');
    expect(applyCodeGrammar('pipe symbol')).toBe('|');
  });

  it('applies each case style', () => {
    expect(applyCodeGrammar('camel case user profile id')).toBe('userProfileId');
    expect(applyCodeGrammar('pascal case user profile')).toBe('UserProfile');
    expect(applyCodeGrammar('snake case max retry count')).toBe('max_retry_count');
    expect(applyCodeGrammar('kebab case my component')).toBe('my-component');
    expect(applyCodeGrammar('constant case max size')).toBe('MAX_SIZE');
    expect(applyCodeGrammar('screaming snake case api key')).toBe('API_KEY');
  });

  it('bounds a case transform at surrounding punctuation', () => {
    // A converted symbol acts as a boundary so the capture does not run away.
    expect(applyCodeGrammar('snake case user id open brace')).toBe('user_id {');
  });

  it('leaves ordinary code words untouched', () => {
    expect(applyCodeGrammar('return the value')).toBe('return the value');
  });
});
