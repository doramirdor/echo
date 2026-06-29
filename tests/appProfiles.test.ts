import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/main/settings/settings', () => ({
  getSetting: vi.fn((key: string) => {
    if (key === 'appProfiles') return {};
    return undefined;
  }),
}));

import { detectAppProfile, getProfilePrompt } from '../src/main/context/appProfiles';

describe('appProfiles', () => {
  it('detects coding profile for VS Code', () => {
    expect(detectAppProfile('Visual Studio Code')).toBe('coding');
  });

  it('detects chat profile for Slack', () => {
    expect(detectAppProfile('Slack')).toBe('chat');
  });

  it('detects prose profile for Notion', () => {
    expect(detectAppProfile('Notion')).toBe('prose');
  });

  it('returns default for unknown apps', () => {
    expect(detectAppProfile('Unknown App')).toBe('default');
  });

  it('returns empty prompt for default profile', () => {
    expect(getProfilePrompt('Unknown App')).toBe('');
  });

  it('returns coding prompt for Cursor', () => {
    const prompt = getProfilePrompt('Cursor');
    expect(prompt).toContain('code editor');
  });

  it('detects shell profile for terminals', () => {
    expect(detectAppProfile('Terminal')).toBe('shell');
    expect(detectAppProfile('iTerm2')).toBe('shell');
    expect(detectAppProfile('Warp')).toBe('shell');
  });

  it('returns a shell prompt that preserves command syntax', () => {
    const prompt = getProfilePrompt('Terminal');
    expect(prompt.toLowerCase()).toContain('terminal');
    expect(prompt.toLowerCase()).toContain('command syntax');
  });
});
