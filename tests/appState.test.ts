import { describe, it, expect } from 'vitest';
import { EchoState, AppState } from '../src/main/appState';

describe('AppState', () => {
  it('starts in Idle state', () => {
    const state = new AppState();
    expect(state.state).toBe(EchoState.Idle);
  });

  it('transitions through recording pipeline', () => {
    const state = new AppState();
    state.setState(EchoState.Recording);
    expect(state.isRecording).toBe(true);
    expect(state.isBusy).toBe(true);

    state.setState(EchoState.Transcribing);
    expect(state.isRecording).toBe(false);
    expect(state.isBusy).toBe(true);

    state.setState(EchoState.Idle);
    expect(state.isBusy).toBe(false);
  });

  it('stores transcription results', () => {
    const state = new AppState();
    state.setTranscription('raw text', 'refined text');
    expect(state.lastTranscription).toBe('raw text');
    expect(state.lastRefinedText).toBe('refined text');
  });

  it('stores error messages', () => {
    const state = new AppState();
    state.setState(EchoState.Error, 'test error');
    expect(state.errorMessage).toBe('test error');
  });
});
