import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../utils/logger';

/**
 * Learns from the edits a user makes to inserted text.
 *
 * After Echo inserts refined text, the user often tweaks it by hand ("Claude"
 * where Echo wrote "cloud", "use" where it wrote "utilise"…). The next time they
 * dictate into the same field, `learnFromField()` re-reads the field, re-locates
 * what Echo had inserted, and diffs it against the edited version. Recurring
 * substitutions are remembered and fed back to the refiner as preferences — so
 * Echo produces the corrected version on its own.
 *
 * This is the sibling of {@link VocabularyLearner}: that one learns STT
 * misrecognitions (raw → refined), this one learns the user's own corrections
 * (refined → hand-edited). Corrections are applied as REFINER CONTEXT only — the
 * model still decides per sentence; nothing is force-replaced.
 */

const CORRECTIONS_FILE = path.join(
  os.homedir(), 'Library', 'Application Support', 'echo', 'edit-corrections.json',
);

// A correction must recur this many times before Echo trusts it enough to feed
// back to the refiner. Edits are high-signal (the user deliberately changed the
// text), so this is lower than the vocabulary learner's raw→refined threshold.
const AUTO_ACCEPT_THRESHOLD = 2;
const MAX_STORED = 200;         // cap the store; evict lowest-count/oldest beyond this
const MAX_PROMPT_ENTRIES = 20;  // cap how many corrections we feed the refiner
const MAX_SPAN_WORDS = 6;       // ignore edits longer than this on either side (too specific to generalize)
const MIN_SIMILARITY = 0.4;     // below this the edit replaced too much to be a targeted correction

export interface EditCorrection {
  from: string;
  to: string;
  count: number;
  createdAt: string;
  updatedAt: string;
}

/** A snapshot of the last text Echo inserted, so the next read can re-locate it. */
interface PendingInsertion {
  inserted: string;      // exact string placed into the field
  beforeAnchor: string;  // field text immediately before the inserted text
  afterAnchor: string;   // field text immediately after the inserted text
}

export class EditLearner {
  private corrections: EditCorrection[] = [];
  private pending: PendingInsertion | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load();
  }

  /**
   * Snapshot the text just inserted (and its surrounding field context) so the
   * next dictation can detect how the user edited it. Overwrites any prior
   * pending snapshot — we only track the most recent insertion.
   */
  recordInsertion(p: PendingInsertion): void {
    if (!p.inserted.trim()) {
      this.pending = null;
      return;
    }
    this.pending = p;
  }

  /**
   * Called at the start of the next dictation with a fresh read of the focused
   * field. If the previously inserted text is still locatable and was edited,
   * learn the substitution(s). Returns whatever was learned (for logging/tests).
   *
   * Consumes the pending snapshot unconditionally: detection gets exactly one
   * shot, at the next dictation.
   */
  learnFromField(field: { before: string; after: string }): EditCorrection[] {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return [];

    const { beforeAnchor, afterAnchor, inserted } = pending;
    const fullNow = field.before + field.after;

    // Re-locate our inserted region by stripping the (unchanged) surrounding
    // text. If the surroundings changed — different field, different app, or the
    // user restructured around it — bail rather than risk learning noise.
    if (!fullNow.startsWith(beforeAnchor)) return [];
    if (!fullNow.endsWith(afterAnchor)) return [];
    if (fullNow.length < beforeAnchor.length + afterAnchor.length) return [];
    const editedRegion = fullNow.slice(beforeAnchor.length, fullNow.length - afterAnchor.length);

    if (normalize(editedRegion) === normalize(inserted)) return []; // untouched

    // extractSubstitutions applies the similarity guard: a wholesale rewrite
    // (user replaced everything / dictated something unrelated) yields nothing.
    const subs = extractSubstitutions(inserted, editedRegion);
    if (subs.length === 0) return [];

    const learned: EditCorrection[] = [];
    for (const s of subs) {
      const entry = this.record(s.from, s.to);
      if (entry) learned.push(entry);
    }
    if (learned.length > 0) this.scheduleSave();
    return learned;
  }

  /**
   * Format the trusted corrections (seen ≥ threshold) for the refiner prompt.
   * Empty string when there's nothing confident to add.
   */
  formatForPrompt(): string {
    const active = this.corrections
      .filter(c => c.count >= AUTO_ACCEPT_THRESHOLD)
      .sort((a, b) => b.count - a.count || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_PROMPT_ENTRIES);
    if (active.length === 0) return '';
    return active.map(c => `- "${c.from}" → "${c.to}"`).join('\n');
  }

  getAll(): EditCorrection[] {
    return [...this.corrections];
  }

  clear(): void {
    this.corrections = [];
    this.pending = null;
    this.scheduleSave();
  }

  /** Record one substitution, tallying repeats. Returns the (updated) entry or null if rejected. */
  private record(from: string, to: string): EditCorrection | null {
    const f = from.trim();
    const t = to.trim();
    if (!f || !t) return null;
    if (stripPunct(f) === stripPunct(t)) return null; // pure punctuation/casing churn — not a correction

    const now = new Date().toISOString();

    // If the user just reversed a previously-learned correction (edited Y back to
    // X), drop the stale forward rule so we don't fight them.
    this.corrections = this.corrections.filter(c => !(eq(c.from, t) && eq(c.to, f)));

    const existing = this.corrections.find(c => eq(c.from, f) && eq(c.to, t));
    if (existing) {
      existing.count++;
      existing.updatedAt = now;
      logger.info('edit-learner', `Correction "${f}" → "${t}" (seen ${existing.count}x)`);
      return existing;
    }

    const entry: EditCorrection = { from: f, to: t, count: 1, createdAt: now, updatedAt: now };
    this.corrections.push(entry);
    if (this.corrections.length > MAX_STORED) {
      this.corrections.sort((a, b) => b.count - a.count || b.updatedAt.localeCompare(a.updatedAt));
      this.corrections = this.corrections.slice(0, MAX_STORED);
    }
    logger.info('edit-learner', `New correction "${f}" → "${t}"`);
    return entry;
  }

  private load(): void {
    try {
      if (fs.existsSync(CORRECTIONS_FILE)) {
        const data = JSON.parse(fs.readFileSync(CORRECTIONS_FILE, 'utf-8'));
        this.corrections = Array.isArray(data) ? data : [];
      }
    } catch (err) {
      logger.warn('edit-learner', `Failed to load: ${(err as Error).message}`);
      this.corrections = [];
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 1000);
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(CORRECTIONS_FILE), { recursive: true });
      fs.writeFileSync(CORRECTIONS_FILE, JSON.stringify(this.corrections, null, 2));
    } catch (err) {
      logger.warn('edit-learner', `Failed to save: ${(err as Error).message}`);
    }
  }

  /** Flush any pending save immediately. Used during app shutdown. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
    }
  }
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function stripPunct(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function eq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Word-level diff between the text Echo inserted and the user's edited version,
 * returning only the substituted spans as `{from, to}` pairs.
 *
 * Uses an LCS alignment: matched words anchor the diff, and each run of
 * unmatched words on both sides becomes one substitution. Pure insertions and
 * pure deletions are skipped (adding or removing a clause is too context-specific
 * to generalize into a correction). A wholesale rewrite — LCS similarity below
 * {@link MIN_SIMILARITY} — returns nothing, so unrelated text never pollutes.
 */
export function extractSubstitutions(before: string, after: string): { from: string; to: string }[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  if (a.length === 0 || b.length === 0) return [];

  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i].toLowerCase() === b[j].toLowerCase()
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Reject wholesale rewrites — the user replaced the text rather than correcting
  // a word. Exception: a very short (≤2-word) field can legitimately be swapped
  // in full ("cloud" → "Claude"), where there's no surrounding context to share;
  // there the recurrence threshold, not similarity, provides the precision.
  const similarity = (2 * dp[0][0]) / (n + m);
  const shortEnough = Math.min(n, m) <= 2;
  if (similarity < MIN_SIMILARITY && !shortEnough) return [];

  const subs: { from: string; to: string }[] = [];
  let fromRun: string[] = [];
  let toRun: string[] = [];
  const flush = (): void => {
    if (
      fromRun.length > 0 && toRun.length > 0 &&
      fromRun.length <= MAX_SPAN_WORDS && toRun.length <= MAX_SPAN_WORDS
    ) {
      subs.push({ from: fromRun.join(' '), to: toRun.join(' ') });
    }
    fromRun = [];
    toRun = [];
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].toLowerCase() === b[j].toLowerCase()) {
      flush();
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      fromRun.push(a[i++]);
    } else {
      toRun.push(b[j++]);
    }
  }
  while (i < n) fromRun.push(a[i++]);
  while (j < m) toRun.push(b[j++]);
  flush();

  return subs;
}

let editLearner: EditLearner | null = null;
export function getEditLearner(): EditLearner {
  if (!editLearner) editLearner = new EditLearner();
  return editLearner;
}
