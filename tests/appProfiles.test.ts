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

  it('detects the prompt profile for dedicated AI assistants', () => {
    expect(detectAppProfile('ChatGPT')).toBe('prompt');
    expect(detectAppProfile('Claude')).toBe('prompt');
    expect(detectAppProfile('Perplexity')).toBe('prompt');
  });

  it('keeps AI-enabled code editors on the coding profile by default', () => {
    expect(detectAppProfile('Cursor')).toBe('coding');
    expect(detectAppProfile('Windsurf')).toBe('coding');
  });

  it('returns a prompt profile that preserves every detail and does not act on the request', () => {
    const prompt = getProfilePrompt('ChatGPT');
    expect(prompt.toLowerCase()).toContain('prompt');
    expect(prompt.toLowerCase()).toContain('verbatim');
    expect(prompt.toLowerCase()).toContain('do not answer');
  });

  it('detects the email profile for mail clients', () => {
    expect(detectAppProfile('Mail')).toBe('email');
    expect(detectAppProfile('Microsoft Outlook')).toBe('email');
    expect(detectAppProfile('Superhuman')).toBe('email');
  });

  it('returns an email prompt that adds no line breaks the speaker did not dictate', () => {
    const prompt = getProfilePrompt('Mail');
    expect(prompt.toLowerCase()).toContain('email');
    expect(prompt.toLowerCase()).toContain('courteous');
    expect(prompt).toContain('do not add a greeting/sign-off layout');
  });
});
