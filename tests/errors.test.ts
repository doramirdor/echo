import { describe, it, expect } from 'vitest';
import { toUserFacingError } from '../src/main/utils/errors';

describe('toUserFacingError', () => {
  it('maps SoX errors', () => {
    const msg = toUserFacingError(new Error('rec: command not found'));
    expect(msg).toContain('SoX');
  });

  it('maps Whisper errors', () => {
    const msg = toUserFacingError(new Error('Whisper binary not found'));
    expect(msg).toContain('Whisper');
  });

  it('maps accessibility errors', () => {
    const msg = toUserFacingError(new Error('Not authorized assistive'));
    expect(msg).toContain('Accessibility');
  });

  it('passes through short unknown errors', () => {
    const msg = toUserFacingError(new Error('Something went wrong'));
    expect(msg).toBe('Something went wrong');
  });
});
