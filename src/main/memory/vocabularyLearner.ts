import { AUTO_LEARNED_CONTEXT, MemoryStore } from '../memory/memoryStore';
import { logger } from '../utils/logger';

export interface SuggestedCorrection {
  term: string;
  misrecognition: string;
  count: number;
}

const AUTO_ACCEPT_THRESHOLD = 3;
const MAX_SUGGESTIONS = 500;
// Below this length a 2-char difference is most of the word, so fuzzy matching is noise.
const MIN_FUZZY_WORD_LENGTH = 4;

/**
 * Compare raw transcription to refined output and learn vocabulary corrections.
 */
export class VocabularyLearner {
  private suggestions: Map<string, SuggestedCorrection> = new Map();

  constructor(private memory: MemoryStore) {}

  /**
   * Extract word-level corrections between raw and refined text.
   */
  analyze(raw: string, refined: string): SuggestedCorrection[] {
    const rawWords = tokenize(raw);
    const refinedWords = tokenize(refined);
    const newSuggestions: SuggestedCorrection[] = [];

    // Simple alignment: find words that changed case/spelling
    const rawLower = raw.toLowerCase();
    const refinedLower = refined.toLowerCase();

    if (rawLower === refinedLower) return [];

    // Extract quoted or capitalized terms from refined that differ from raw
    for (const refinedWord of refinedWords) {
      if (refinedWord.length < 2) continue;
      const rawMatch = rawWords.find(w => w.toLowerCase() === refinedWord.toLowerCase());
      if (rawMatch && rawMatch !== refinedWord) continue; // same word, different case handled below

      // Find potential misrecognition in raw
      for (const rawWord of rawWords) {
        if (rawWord === refinedWord) continue;
        const isCaseVariant = rawWord.toLowerCase() === refinedWord.toLowerCase();
        // Very short raw words (a, the, to...) produce garbage fuzzy matches;
        // only pure case corrections are worth keeping for them.
        if (!isCaseVariant && rawWord.length < MIN_FUZZY_WORD_LENGTH) continue;
        if (isCaseVariant || soundsSimilar(rawWord, refinedWord)) {
          const key = `${rawWord.toLowerCase()}->${refinedWord}`;
          const existing = this.suggestions.get(key);
          const entry: SuggestedCorrection = existing
            ? { ...existing, count: existing.count + 1 }
            : { term: refinedWord, misrecognition: rawWord, count: 1 };

          this.suggestions.set(key, entry);
          newSuggestions.push(entry);

          if (entry.count >= AUTO_ACCEPT_THRESHOLD) {
            this.autoAccept(entry);
          }
        }
      }
    }

    if (newSuggestions.length > 0) {
      logger.info('vocab-learner', `Found ${newSuggestions.length} correction(s)`);
    }

    this.pruneSuggestions();
    return newSuggestions;
  }

  /** Keep the suggestions map bounded; evict the lowest-count entries first. */
  private pruneSuggestions(): void {
    if (this.suggestions.size <= MAX_SUGGESTIONS) return;
    const byCountAsc = Array.from(this.suggestions.entries())
      .sort((a, b) => a[1].count - b[1].count);
    const excess = this.suggestions.size - MAX_SUGGESTIONS;
    for (let i = 0; i < excess; i++) {
      this.suggestions.delete(byCountAsc[i][0]);
    }
  }

  getSuggestions(): SuggestedCorrection[] {
    return Array.from(this.suggestions.values()).sort((a, b) => b.count - a.count);
  }

  acceptSuggestion(suggestion: SuggestedCorrection): void {
    const existing = this.memory.getAll().find(
      e => e.term.toLowerCase() === suggestion.term.toLowerCase(),
    );

    if (existing) {
      const misrecs = new Set([...existing.misrecognitions, suggestion.misrecognition]);
      this.memory.update(existing.id, { misrecognitions: Array.from(misrecs) });
    } else {
      this.memory.add({
        term: suggestion.term,
        context: AUTO_LEARNED_CONTEXT,
        misrecognitions: [suggestion.misrecognition],
        category: 'productName',
      });
    }

    const key = `${suggestion.misrecognition.toLowerCase()}->${suggestion.term}`;
    this.suggestions.delete(key);
    logger.info('vocab-learner', `Accepted: "${suggestion.misrecognition}" -> "${suggestion.term}"`);
  }

  private autoAccept(suggestion: SuggestedCorrection): void {
    const existing = this.memory.getAll().find(
      e => e.misrecognitions.some(m => m.toLowerCase() === suggestion.misrecognition.toLowerCase()),
    );
    if (existing) return;
    this.acceptSuggestion(suggestion);
  }
}

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function soundsSimilar(a: string, b: string): boolean {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return true;
  // Phonetic-ish: similar length and differ by <=2 chars — but only for words
  // long enough that a 2-char difference is plausibly the same word.
  if (Math.min(al.length, bl.length) < MIN_FUZZY_WORD_LENGTH) return false;
  if (Math.abs(al.length - bl.length) <= 1) {
    let diffs = 0;
    const maxLen = Math.max(al.length, bl.length);
    for (let i = 0; i < maxLen; i++) {
      if (al[i] !== bl[i]) diffs++;
    }
    return diffs <= 2;
  }
  return false;
}
