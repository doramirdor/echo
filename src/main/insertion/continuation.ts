/**
 * Sentence-continuation helpers.
 *
 * When the cursor is placed in the middle of (or at the end of) existing text,
 * dictated speech should *continue* that text rather than start fresh. The LLM
 * is told about the surrounding text, but the mechanical join — spacing and
 * leading capitalisation — is done here deterministically so it's fast, free,
 * and predictable regardless of which (or whether an) LLM ran.
 */

const SENTENCE_ENDERS = new Set(['.', '!', '?', ':', ';']);
const OPENERS = new Set(['(', '[', '{', '"', "'", '“', '‘', '<']);

/**
 * Is the caret sitting mid-sentence? True when there is preceding text whose
 * last non-space character is not sentence-ending punctuation. In that case the
 * dictated text is a continuation and should not be re-capitalised.
 */
export function isMidSentence(before: string): boolean {
  const trimmed = before.replace(/\s+$/, '');
  if (!trimmed) return false;
  const last = trimmed[trimmed.length - 1];
  return !SENTENCE_ENDERS.has(last);
}

/** Should a space be inserted between `before` and the new text? */
export function needsLeadingSpace(before: string, next: string): boolean {
  if (!before) return false;
  const lastChar = before[before.length - 1];
  if (/\s/.test(lastChar)) return false;       // already whitespace
  if (OPENERS.has(lastChar)) return false;     // hugs an opening bracket/quote
  if (!next) return false;
  const firstChar = next[0];
  // Don't space before closing/clinging punctuation.
  if (/[.,!?;:)\]}'"”’]/.test(firstChar)) return false;
  return true;
}

/**
 * A word that should keep its original casing even mid-sentence:
 * "I"/"I'm", acronyms (API), code identifiers (camelCase, snake_case, dotted).
 */
function preservesCase(word: string): boolean {
  if (word === 'I' || /^I['’]/.test(word)) return true;
  if (/^[A-Z]{2,}$/.test(word)) return true;           // ALL-CAPS acronym
  if (/[a-z][A-Z]/.test(word)) return true;            // camelCase / PascalCase
  if (word.includes('_') || /[a-z]\.[a-z]/i.test(word)) return true;
  return false;
}

/** Lowercase only the first letter of the first word, when safe to do so. */
function decapitalizeFirst(text: string): string {
  const m = text.match(/^(\s*)(\S+)([\s\S]*)$/);
  if (!m) return text;
  const [, lead, word, rest] = m;
  if (preservesCase(word)) return text;
  return lead + word.charAt(0).toLowerCase() + word.slice(1) + rest;
}

/**
 * Produce the exact string to insert at the caret so it flows from `before`.
 * Returns ONLY the new text (adjusted), never the existing text.
 *
 * - Adds a leading space when joining two words.
 * - Lowercases the first letter when continuing mid-sentence (unless the word
 *   preserves case, e.g. "I", acronyms, identifiers).
 */
export function joinContinuation(before: string, newText: string): string {
  if (!newText) return newText;
  if (!before) return newText;

  let result = newText;
  if (isMidSentence(before)) {
    result = decapitalizeFirst(result);
  }
  if (needsLeadingSpace(before, result)) {
    result = ' ' + result;
  }
  return result;
}
