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
