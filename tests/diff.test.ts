import { describe, it, expect } from 'vitest';
import { diffWords, changeRatio } from '../src/main/history/diff';

describe('diffWords', () => {
  it('marks an unchanged transcript as all equal', () => {
    const segs = diffWords('hello world', 'hello world');
    expect(segs).toEqual([{ op: 'equal', text: 'hello world' }]);
  });

  it('captures a single-word correction as remove + add', () => {
    const segs = diffWords('my phones for today', 'my plans for today');
    expect(segs).toContainEqual({ op: 'remove', text: 'phones' });
    expect(segs).toContainEqual({ op: 'add', text: 'plans' });
    // The unchanged words stay equal and framed around the change.
    expect(segs[0]).toEqual({ op: 'equal', text: 'my' });
    expect(segs[segs.length - 1]).toEqual({ op: 'equal', text: 'for today' });
  });

  it('captures pure insertions', () => {
    const segs = diffWords('send it John', 'send it to John');
    expect(segs).toContainEqual({ op: 'add', text: 'to' });
    expect(segs.filter(s => s.op === 'remove')).toHaveLength(0);
  });

  it('coalesces adjacent tokens of the same op', () => {
    const segs = diffWords('a b c', 'x y c');
    expect(segs).toContainEqual({ op: 'remove', text: 'a b' });
    expect(segs).toContainEqual({ op: 'add', text: 'x y' });
    expect(segs).toContainEqual({ op: 'equal', text: 'c' });
  });
});

describe('changeRatio', () => {
  it('is 0 when nothing changed', () => {
    expect(changeRatio('hello world', 'hello world')).toBe(0);
  });

  it('is 0 for two empty strings', () => {
    expect(changeRatio('', '')).toBe(0);
  });

  it('grows with the amount rewritten', () => {
    const small = changeRatio('the quick brown fox', 'the quick brown fix');
    const large = changeRatio('the quick brown fox', 'a totally different sentence entirely');
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThanOrEqual(1);
  });
});
