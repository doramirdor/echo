export interface VoiceCommandResult {
  text: string;
  commands: string[];
  skipRefinement: boolean;
}

export interface VoiceCommandOptions {
  /**
   * Enable the deterministic code-dictation grammar (spoken symbols and
   * case transforms). Only meaningful in code/shell contexts — the caller
   * gates this on the app profile so prose/email/chat are never affected.
   */
  codeSymbols?: boolean;
  /**
   * True when an LLM refiner will run on this transcript. Scratch/undo
   * phrases are then left in the text untouched — the refiner's base prompt
   * already implements self-correction and removes the discarded content.
   * When false (default), scratch/undo is applied deterministically here.
   */
  refinerAvailable?: boolean;
}

// Spoken symbols → literal characters, for dictating code. Risky-in-prose words
// (equals, at, hash, pipe, caret, dollar) require a disambiguating suffix so they
// only fire when clearly meant as a symbol; the unambiguous ones can be bare.
const CODE_SYMBOL_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bopen\s+brace\b/gi, replacement: '{' },
  { pattern: /\bclose\s+brace\b/gi, replacement: '}' },
  { pattern: /\bopen\s+bracket\b/gi, replacement: '[' },
  { pattern: /\bclose\s+bracket\b/gi, replacement: ']' },
  { pattern: /\bopen\s+angle\s+bracket\b/gi, replacement: '<' },
  { pattern: /\bclose\s+angle\s+bracket\b/gi, replacement: '>' },
  { pattern: /\bfat\s+arrow\b/gi, replacement: '=>' },
  { pattern: /\bthin\s+arrow\b/gi, replacement: '->' },
  { pattern: /\btriple\s+equals\b/gi, replacement: '===' },
  { pattern: /\bdouble\s+equals\b/gi, replacement: '==' },
  { pattern: /\bnot\s+equals?\b/gi, replacement: '!=' },
  { pattern: /\bequals\s+sign\b/gi, replacement: '=' },
  { pattern: /\bbacktick\b/gi, replacement: '`' },
  { pattern: /\bpipe\s+(?:symbol|character)\b/gi, replacement: '|' },
  { pattern: /\bdollar\s+sign\b/gi, replacement: '$' },
  { pattern: /\b(?:hash\s+(?:sign|tag)|pound\s+sign)\b/gi, replacement: '#' },
  { pattern: /\bat\s+sign\b/gi, replacement: '@' },
  { pattern: /\bunderscore\b/gi, replacement: '_' },
  { pattern: /\basterisk\b/gi, replacement: '*' },
  { pattern: /\bampersand\b/gi, replacement: '&' },
  { pattern: /\bcaret\s+(?:symbol|character)\b/gi, replacement: '^' },
  { pattern: /\bforward\s+slash\b/gi, replacement: '/' },
  { pattern: /\bback\s?slash\b/gi, replacement: '\\' },
];

const CASE_TRANSFORM = /\b(camel|pascal|snake|kebab|constant|screaming\s+snake)\s+case\s+([a-z0-9]+(?:\s+[a-z0-9]+){0,5})/gi;

const capitalize = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

function joinCase(style: string, words: string[]): string {
  const lower = words.map(w => w.toLowerCase());
  switch (style.replace(/\s+/g, ' ').toLowerCase()) {
    case 'camel': return lower.map((w, i) => (i === 0 ? w : capitalize(w))).join('');
    case 'pascal': return lower.map(capitalize).join('');
    case 'snake': return lower.join('_');
    case 'kebab': return lower.join('-');
    case 'constant':
    case 'screaming snake': return lower.map(w => w.toUpperCase()).join('_');
    default: return words.join(' ');
  }
}

/**
 * Deterministic code-dictation grammar. Converts spoken symbols to characters
 * and "<style> case <words>" phrases into identifiers (e.g. "snake case user id"
 * → "user_id"). Runs AFTER punctuation commands so a spoken "period"/"comma" or
 * a code symbol bounds the case-transform capture. Deterministic — works with no
 * LLM configured.
 */
export function applyCodeGrammar(text: string): string {
  let out = text;
  for (const { pattern, replacement } of CODE_SYMBOL_PATTERNS) {
    out = out.replace(pattern, replacement);
    pattern.lastIndex = 0;
  }
  out = out.replace(CASE_TRANSFORM, (_m, style: string, words: string) =>
    joinCase(style, words.trim().split(/\s+/)),
  );
  CASE_TRANSFORM.lastIndex = 0;
  return out;
}

// The bare punctuation words double as ordinary English nouns ("the trial
// period", "comma-separated", "a colon in the URL"). `guarded` entries skip
// replacement in those noun contexts; two-word explicit forms ("new paragraph",
// "question mark") are unambiguous and always fire.
const COMMAND_PATTERNS: Array<{ pattern: RegExp; action: string; replacement?: string; guarded?: boolean }> = [
  { pattern: /\bnew\s+line\b/gi, action: 'newline', replacement: '\n' },
  { pattern: /\bnew\s+paragraph\b/gi, action: 'newparagraph', replacement: '\n\n' },
  { pattern: /\bperiod\b/gi, action: 'period', replacement: '.', guarded: true },
  { pattern: /\bcomma\b/gi, action: 'comma', replacement: ',', guarded: true },
  { pattern: /\bquestion\s+mark\b/gi, action: 'questionmark', replacement: '?' },
  { pattern: /\bexclamation\s+(?:mark|point)\b/gi, action: 'exclamation', replacement: '!' },
  { pattern: /\bcolon\b/gi, action: 'colon', replacement: ':', guarded: true },
  { pattern: /\bsemicolon\b/gi, action: 'semicolon', replacement: ';', guarded: true },
  { pattern: /\bopen\s+(?:parenthesis|paren)\b/gi, action: 'openparen', replacement: '(' },
  { pattern: /\bclose\s+(?:parenthesis|paren)\b/gi, action: 'closeparen', replacement: ')' },
];

// Determiners/possessives and adjective-ish modifiers that precede the NOUN
// sense of period/comma/colon/semicolon. Not exhaustive — covers the common
// false-positive shapes; when unsure we prefer NOT replacing (an LLM pass
// usually fixes punctuation anyway).
const NOUN_CONTEXT_BEFORE = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'each', 'every', 'any',
  'some', 'another', 'my', 'your', 'our', 'his', 'her', 'its', 'their', 'whose',
  'one', 'same', 'whole', 'entire', 'long', 'short', 'brief', 'extended',
  'trial', 'grace', 'time', 'holding', 'question', 'waiting', 'incubation',
  'probation', 'probationary', 'notice', 'cooling-off', 'refractory',
  'gestation', 'quiet', 'rest', 'transition', 'oxford', 'serial', 'inverted',
]);

// Prepositions/complementizers (plus a few noun-compound tails) that follow
// the noun sense ("period of time", "colon cancer") but rarely follow a
// spoken punctuation command.
const NOUN_CONTEXT_AFTER = new Set([
  'of', 'in', 'on', 'at', 'by', 'for', 'from', 'to', 'into', 'within',
  'during', 'when', 'where', 'that', 'which', 'between', 'after', 'before',
  'over', 'under', 'until', 'since', 'while', 'cancer', 'separated', 'delimited',
]);

function isPunctuationNounContext(full: string, offset: number, length: number): boolean {
  // Hyphenated compound: "comma-separated", "semicolon-delimited".
  if (full[offset - 1] === '-' || full[offset + length] === '-') return true;
  // Adjacent words only (whitespace between) — a sentence boundary in between
  // means the neighbor belongs to another clause and is not noun context.
  const prev = /([a-z'-]+)\s*$/i.exec(full.slice(0, offset));
  if (prev && NOUN_CONTEXT_BEFORE.has(prev[1].toLowerCase())) return true;
  const next = /^\s*([a-z'-]+)/i.exec(full.slice(offset + length));
  if (next && NOUN_CONTEXT_AFTER.has(next[1].toLowerCase())) return true;
  return false;
}

const SCRATCH_PHRASE = /\b(scratch|undo)\s+that\b\s*[.!?,]*/i;

/** Index just past the last sentence terminator in `s` (0 if none). */
function sentenceStart(s: string): number {
  for (let i = s.length - 1; i >= 0; i--) {
    const ch = s[i];
    if (ch === '.' || ch === '!' || ch === '?' || ch === '\n') return i + 1;
  }
  return 0;
}

/**
 * Deterministic scratch/undo semantics for when no refiner will run:
 * embedded mid-sentence ("hello scratch that") deletes from the start of that
 * sentence through the phrase; standing alone as its own sentence
 * ("Hello. Scratch that.") also deletes the previous sentence. Works on both
 * punctuated (whisper.cpp) and unpunctuated input.
 */
function applyScratchCommands(text: string): { text: string; actions: string[] } {
  const actions: string[] = [];
  let out = text;
  for (let m = SCRATCH_PHRASE.exec(out); m; m = SCRATCH_PHRASE.exec(out)) {
    const action = m[1].toLowerCase() === 'undo' ? 'undo' : 'scratch';
    if (!actions.includes(action)) actions.push(action);
    const before = out.slice(0, m.index);
    let from = sentenceStart(before);
    if (before.slice(from).trim() === '') {
      // The phrase is its own sentence — discard the previous sentence too.
      from = sentenceStart(before.slice(0, Math.max(0, from - 1)));
    }
    const left = out.slice(0, from);
    const right = out.slice(m.index + m[0].length);
    out = left && right && !/\s$/.test(left) && !/^\s/.test(right)
      ? `${left} ${right}`
      : left + right;
  }
  return { text: out, actions };
}

/**
 * Process voice commands embedded in transcription text.
 */
export function processVoiceCommands(
  text: string,
  enabled: boolean,
  opts: VoiceCommandOptions = {},
): VoiceCommandResult {
  if (!enabled) return { text, commands: [], skipRefinement: false };

  let result = text;
  const commands: string[] = [];
  let skipRefinement = false;

  for (const { pattern, action, replacement, guarded } of COMMAND_PATTERNS) {
    let matched = false;
    result = result.replace(pattern, (match: string, offset: number, full: string) => {
      if (guarded && isPunctuationNounContext(full, offset, match.length)) return match;
      matched = true;
      return replacement ?? '';
    });
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    if (matched) commands.push(action);
  }

  // Scratch/undo: with a refiner available the phrase is left untouched — the
  // refiner's self-correction prompt removes the discarded content. Without
  // one, apply deterministic sentence-level deletion here.
  if (!opts.refinerAvailable) {
    const scratched = applyScratchCommands(result);
    if (scratched.actions.length > 0) {
      result = scratched.text;
      commands.push(...scratched.actions);
      skipRefinement = true;
    }
  }

  // Code grammar (symbols + case transforms) — only in code/shell contexts, and
  // after punctuation commands so their characters bound the case-transform capture.
  if (opts.codeSymbols) {
    const withCode = applyCodeGrammar(result);
    if (withCode !== result) {
      commands.push('code-grammar');
      result = withCode;
    }
  }

  return {
    text: result.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim(),
    commands,
    skipRefinement,
  };
}
