/**
 * Word-level diff between the raw transcript and the refined output — the basis
 * of the "what did the LLM change?" trust surface. Developers won't trust an LLM
 * silently rewriting their words; showing the delta proves Echo is *correcting*,
 * not *rewriting*.
 *
 * Pure and dependency-free so it can be unit-tested and reused (e.g. a "how much
 * does refinement change my words" metric in Insights). The renderer mirrors this
 * algorithm to draw the diff inline in history.
 */

export type DiffOp = 'equal' | 'add' | 'remove';

export interface DiffSegment {
  op: DiffOp;
  /** The whitespace-joined run of tokens for this segment. */
  text: string;
}

function tokenize(s: string): string[] {
  return s.trim().length ? s.trim().split(/\s+/) : [];
}

/** Length of the longest common subsequence table (word tokens). */
function lcsTable(a: string[], b: string[]): number[][] {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/**
 * Produce a compact word-level diff from `raw` → `refined`. Adjacent tokens with
 * the same op are merged into one segment for readable rendering.
 */
export function diffWords(raw: string, refined: string): DiffSegment[] {
  const a = tokenize(raw);
  const b = tokenize(refined);
  const dp = lcsTable(a, b);

  const raw_ops: Array<{ op: DiffOp; token: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      raw_ops.push({ op: 'equal', token: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw_ops.push({ op: 'remove', token: a[i] });
      i++;
    } else {
      raw_ops.push({ op: 'add', token: b[j] });
      j++;
    }
  }
  while (i < a.length) raw_ops.push({ op: 'remove', token: a[i++] });
  while (j < b.length) raw_ops.push({ op: 'add', token: b[j++] });

  // Coalesce runs of the same op.
  const segments: DiffSegment[] = [];
  for (const { op, token } of raw_ops) {
    const last = segments[segments.length - 1];
    if (last && last.op === op) last.text += ' ' + token;
    else segments.push({ op, text: token });
  }
  return segments;
}

/**
 * Fraction of words changed between raw and refined, in [0, 1]. 0 means the LLM
 * left every word alone; higher means more was rewritten. Uses the word-level
 * LCS so it is insensitive to pure reordering noise.
 */
export function changeRatio(raw: string, refined: string): number {
  const a = tokenize(raw);
  const b = tokenize(refined);
  const total = a.length + b.length;
  if (total === 0) return 0;
  const equal = lcsTable(a, b)[0]?.[0] ?? 0;
  return 1 - (2 * equal) / total;
}
