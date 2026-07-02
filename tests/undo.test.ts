import { describe, it, expect, vi } from 'vitest';
import { AppState, EchoState } from '../src/main/appState';
import { undoLastInsertion } from '../src/main/insertion/undo';
import type { TextInserter } from '../src/main/insertion/textInserter';

function fakeInserter() {
  return { undoLastInsertion: vi.fn().mockResolvedValue(undefined) } as unknown as TextInserter;
}

describe('undoLastInsertion', () => {
  it('reverts the last insertion, targeting the app it went into, then clears it', async () => {
    const appState = new AppState();
    appState.setLastInsertion('hello world', 'Slack');
    const inserter = fakeInserter();

    const undone = await undoLastInsertion(appState, inserter);

    expect(undone).toBe(true);
    expect(inserter.undoLastInsertion).toHaveBeenCalledWith('hello world', 'Slack');
    expect(appState.lastInsertedText).toBeNull();
  });

  it('is a one-shot: a second undo does nothing (no double-delete)', async () => {
    const appState = new AppState();
    appState.setLastInsertion('hello', null);
    const inserter = fakeInserter();

    expect(await undoLastInsertion(appState, inserter)).toBe(true);
    expect(await undoLastInsertion(appState, inserter)).toBe(false);
    expect(inserter.undoLastInsertion).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is nothing to undo', async () => {
    const appState = new AppState();
    const inserter = fakeInserter();
    expect(await undoLastInsertion(appState, inserter)).toBe(false);
    expect(inserter.undoLastInsertion).not.toHaveBeenCalled();
  });

  it('refuses to fire while the pipeline is busy', async () => {
    const appState = new AppState();
    appState.setLastInsertion('hello', null);
    appState.setState(EchoState.Recording);
    const inserter = fakeInserter();

    expect(await undoLastInsertion(appState, inserter)).toBe(false);
    expect(inserter.undoLastInsertion).not.toHaveBeenCalled();
    // Still available to undo once the pipeline returns to idle.
    appState.setState(EchoState.Idle);
    expect(await undoLastInsertion(appState, inserter)).toBe(true);
  });

  it('keeps the record on failure so the user can retry', async () => {
    const appState = new AppState();
    appState.setLastInsertion('hello', 'Cursor');
    const inserter = { undoLastInsertion: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as TextInserter;

    expect(await undoLastInsertion(appState, inserter)).toBe(false);
    expect(appState.lastInsertedText).toBe('hello');
  });
});
