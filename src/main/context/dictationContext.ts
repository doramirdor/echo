import { getSetting } from '../settings/settings';
import { RunLog } from '../history/runLog';

/**
 * Build conversation context from recent dictations for pronoun resolution.
 */
export function buildDictationContext(runLog: RunLog): string {
  const count = getSetting('dictationHistoryContext') || 0;
  if (count <= 0) return '';

  const recent = runLog.getAll()
    .filter(e => !e.error && e.refinedText)
    .slice(0, count);

  if (recent.length === 0) return '';

  return recent
    .reverse()
    .map((e, i) => `[${i + 1}] "${e.refinedText}"`)
    .join('\n');
}
