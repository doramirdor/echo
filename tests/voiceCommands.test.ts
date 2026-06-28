import { describe, it, expect } from 'vitest';
import { processVoiceCommands } from '../src/main/voice/voiceCommands';

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
});
