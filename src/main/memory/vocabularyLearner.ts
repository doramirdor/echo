import { MemoryStore } from '../memory/memoryStore';
import { logger } from '../utils/logger';

export interface SuggestedCorrection {
  term: string;
  misrecognition: string;
  count: number;
}

const AUTO_ACCEPT_THRESHOLD = 3;

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
        if (soundsSimilar(rawWord, refinedWord) || rawWord.toLowerCase() === refinedWord.toLowerCase()) {
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

    return newSuggestions;
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
        context: `Auto-learned correction`,
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
  // Phonetic-ish: same length and differ by <=2 chars
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
