import { MemoryEntry } from '../memory/memoryEntry';

/**
 * Builds an "initial prompt" for the STT engine that biases recognition toward
 * the user's jargon, project terminology, and frequently-corrected words.
 *
 * whisper.cpp (and the OpenAI/Groq Whisper APIs) accept a short prior-context
 * string that nudges the decoder toward specific spellings. Feeding the project
 * vocabulary here fixes terms *during* recognition — far more reliable than
 * correcting them afterwards with the LLM, and it costs nothing.
 *
 * The decoder only attends to a small window (~224 tokens for whisper), so we
 * keep the result well under that and prioritise the highest-signal terms.
 */

// whisper attends to ~224 tokens of prompt; ~900 chars is a safe ceiling.
const MAX_PROMPT_CHARS = 900;

export interface SpeechBiasInput {
  vocabularyList?: string;
  memoryEntries?: MemoryEntry[];
  projectContext?: string | null;
}

/**
 * Heuristically extract code-/domain-identifiers from a free-form context doc:
 * CamelCase, snake_case, dotted.names, ALL_CAPS acronyms, and backtick/quoted tokens.
 */
export function extractIdentifiers(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();

  // Tokens inside backticks or quotes are almost always names worth keeping.
  for (const m of text.matchAll(/[`"']([A-Za-z][A-Za-z0-9_.-]{1,40})[`"']/g)) {
    found.add(m[1]);
  }

  // Bare identifier-ish tokens: must look "technical" rather than plain English.
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_.]{2,40}/g)) {
    const tok = m[0];
    const isCamel = /[a-z][A-Z]/.test(tok);          // camelCase / PascalCase boundary
    const hasUnderscore = tok.includes('_');
    const isDotted = /[a-z]\.[a-z]/i.test(tok);       // dotted.path
    const isAcronym = /^[A-Z]{2,6}$/.test(tok);       // API, HTTP, LLM
    if (isCamel || hasUnderscore || isDotted || isAcronym) {
      found.add(tok);
    }
  }

  return [...found];
}

/** Split a free-text vocabulary list (newlines/commas) into trimmed terms. */
function splitTerms(list: string): string[] {
  return list
    .split(/[\n,]/)
    .map(t => t.trim())
    .filter(Boolean);
}

export function buildSpeechBiasPrompt(input: SpeechBiasInput): string {
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const key = t.toLowerCase();
    if (t && !seen.has(key)) {
      seen.add(key);
      terms.push(t);
    }
  };

  // 1. User vocabulary list — highest priority (explicitly curated).
  if (input.vocabularyList) splitTerms(input.vocabularyList).forEach(push);

  // 2. Learned memory terms — things the user has corrected before.
  if (input.memoryEntries) {
    for (const e of input.memoryEntries) push(e.term);
  }

  // 3. Project jargon mined from the scanned codebase context.
  if (input.projectContext) extractIdentifiers(input.projectContext).forEach(push);

  if (terms.length === 0) return '';

  // Phrase it as natural prior context so the decoder treats it as vocabulary,
  // not as something to transcribe. Cap to the token window.
  let prompt = `Vocabulary: ${terms.join(', ')}.`;
  if (prompt.length > MAX_PROMPT_CHARS) {
    prompt = prompt.slice(0, MAX_PROMPT_CHARS);
    // Trim back to the last clean separator so we don't cut a term in half.
    const lastComma = prompt.lastIndexOf(',');
    if (lastComma > 40) prompt = prompt.slice(0, lastComma) + '.';
  }
  return prompt;
}
