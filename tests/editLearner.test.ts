import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keep the learner (and the logger it pulls in) off the real filesystem — both
// read/write under ~/Library/Application Support/echo. existsSync:false makes the
// store load empty; every write is a no-op.
vi.mock('fs', () => ({
  existsSync: () => false,
  readFileSync: () => '[]',
  writeFileSync: () => {},
  appendFileSync: () => {},
  mkdirSync: () => {},
  statSync: () => ({ size: 0 }),
  renameSync: () => {},
  unlinkSync: () => {},
}));

import { EditLearner, extractSubstitutions } from '../src/main/memory/editLearner';

describe('extractSubstitutions', () => {
  it('extracts a single-word substitution inside a sentence', () => {
    expect(extractSubstitutions('let us ask the cloud model', 'let us ask the Claude model'))
      .toEqual([{ from: 'cloud', to: 'Claude' }]);
  });

  it('extracts a multi-word substitution', () => {
    expect(extractSubstitutions('meet on monday please', 'meet on tuesday morning please'))
      .toEqual([{ from: 'monday', to: 'tuesday morning' }]);
  });

  it('allows an isolated single-word field swap (no shared context)', () => {
    expect(extractSubstitutions('cloud', 'Claude')).toEqual([{ from: 'cloud', to: 'Claude' }]);
  });

  it('returns nothing when the text is unchanged', () => {
    expect(extractSubstitutions('same text here', 'same text here')).toEqual([]);
  });

  it('ignores a wholesale rewrite (low similarity, not short)', () => {
    expect(extractSubstitutions('the quick brown fox', 'a completely different thing entirely')).toEqual([]);
  });

  it('ignores pure insertions and pure deletions', () => {
    // Appended a clause — no substitution span (both-sided), so nothing to learn.
    expect(extractSubstitutions('call me later', 'call me later today please')).toEqual([]);
    // Removed a word — likewise.
    expect(extractSubstitutions('call me later today', 'call me later')).toEqual([]);
  });

  it('captures multiple substitutions in one edit', () => {
    expect(extractSubstitutions('the cat sat on the mat', 'the dog sat on the rug'))
      .toEqual([{ from: 'cat', to: 'dog' }, { from: 'mat', to: 'rug' }]);
  });
});

describe('EditLearner', () => {
  let learner: EditLearner;

  beforeEach(() => {
    learner = new EditLearner();
  });

  function correctOnce(inserted: string, edited: string, before = '', after = ''): void {
    learner.recordInsertion({ inserted, beforeAnchor: before, afterAnchor: after });
    learner.learnFromField({ before: before + edited, after });
  }

  it('applies a correction only after the recurrence threshold', () => {
    correctOnce('call the cloud', 'call the Claude');
    expect(learner.formatForPrompt()).toBe(''); // seen once — not yet trusted

    correctOnce('call the cloud', 'call the Claude');
    expect(learner.formatForPrompt()).toBe('- "cloud" → "Claude"'); // seen twice — trusted
  });

  it('re-locates the edit using surrounding field text', () => {
    const before = 'Hey team, ';
    const after = ' by friday.';
    correctOnce('ship the featur', 'ship the feature', before, after);
    correctOnce('ship the featur', 'ship the feature', before, after);
    expect(learner.formatForPrompt()).toBe('- "featur" → "feature"');
  });

  it('does not learn when the surrounding text no longer matches', () => {
    learner.recordInsertion({ inserted: 'call the cloud', beforeAnchor: 'A ', afterAnchor: '' });
    learner.learnFromField({ before: 'B call the Claude', after: '' }); // prefix 'A ' missing
    learner.recordInsertion({ inserted: 'call the cloud', beforeAnchor: 'A ', afterAnchor: '' });
    learner.learnFromField({ before: 'B call the Claude', after: '' });
    expect(learner.formatForPrompt()).toBe('');
  });

  it('ignores an untouched insertion', () => {
    correctOnce('perfect as is', 'perfect as is');
    correctOnce('perfect as is', 'perfect as is');
    expect(learner.formatForPrompt()).toBe('');
    expect(learner.getAll()).toHaveLength(0);
  });

  it('consumes the pending snapshot — a second read cannot double-learn', () => {
    learner.recordInsertion({ inserted: 'call the cloud', beforeAnchor: '', afterAnchor: '' });
    learner.learnFromField({ before: 'call the Claude', after: '' });
    // No new recordInsertion: the pending snapshot is already spent.
    learner.learnFromField({ before: 'call the Claude', after: '' });
    const entry = learner.getAll().find(c => c.from.toLowerCase() === 'cloud');
    expect(entry?.count).toBe(1);
  });

  it('drops a forward rule when the user reverses it', () => {
    correctOnce('call the cloud', 'call the Claude');
    correctOnce('call the cloud', 'call the Claude');
    expect(learner.formatForPrompt()).toBe('- "cloud" → "Claude"');

    // User changes their mind and edits "Claude" back to "cloud".
    correctOnce('ping the Claude', 'ping the cloud');
    expect(learner.formatForPrompt()).toBe('');
  });

  it('ignores punctuation-only and casing-only edits', () => {
    correctOnce('hello world', 'hello world.');
    correctOnce('hello world', 'hello world.');
    expect(learner.getAll()).toHaveLength(0);
  });
});
