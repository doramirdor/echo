import { AppState } from '../appState';
import type { TextInserter } from './textInserter';
import { logger } from '../utils/logger';

/**
 * Revert the most recent insertion. Shared by the global undo hotkey (index.ts)
 * and the renderer-facing IPC command (ipc.ts) so the guard/clear lifecycle
 * lives in exactly one place.
 *
 * Returns true if something was undone. It is a one-shot: the stored last
 * insertion is cleared afterwards so pressing the hotkey again is a no-op rather
 * than deleting more of the user's text.
 */
export async function undoLastInsertion(appState: AppState, inserter: TextInserter): Promise<boolean> {
  // Never fire mid-pipeline (recording/transcribing/refining/inserting).
  if (appState.isBusy) {
    logger.info('undo', 'Ignored — pipeline is busy');
    return false;
  }
  const text = appState.lastInsertedText;
  if (!text) {
    logger.info('undo', 'Nothing to undo');
    return false;
  }
  try {
    await inserter.undoLastInsertion(text, appState.lastInsertionSourceApp);
    appState.clearLastInsertion();
    logger.info('undo', `Reverted ${Array.from(text).length} chars`);
    return true;
  } catch (err) {
    logger.warn('undo', `Undo failed: ${(err as Error).message}`);
    return false;
  }
}
