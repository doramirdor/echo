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

const COMMAND_PATTERNS: Array<{ pattern: RegExp; action: string; replacement?: string }> = [
  { pattern: /\bnew\s+line\b/gi, action: 'newline', replacement: '\n' },
  { pattern: /\bnew\s+paragraph\b/gi, action: 'newparagraph', replacement: '\n\n' },
  { pattern: /\bperiod\b/gi, action: 'period', replacement: '.' },
  { pattern: /\bcomma\b/gi, action: 'comma', replacement: ',' },
  { pattern: /\bquestion\s+mark\b/gi, action: 'questionmark', replacement: '?' },
  { pattern: /\bexclamation\s+(?:mark|point)\b/gi, action: 'exclamation', replacement: '!' },
  { pattern: /\bcolon\b/gi, action: 'colon', replacement: ':' },
  { pattern: /\bsemicolon\b/gi, action: 'semicolon', replacement: ';' },
  { pattern: /\bopen\s+(?:parenthesis|paren)\b/gi, action: 'openparen', replacement: '(' },
  { pattern: /\bclose\s+(?:parenthesis|paren)\b/gi, action: 'closeparen', replacement: ')' },
  { pattern: /\bscratch\s+that\b/gi, action: 'scratch', replacement: '' },
  { pattern: /\bundo\s+that\b/gi, action: 'undo', replacement: '' },
];

const META_COMMANDS = new Set(['scratch', 'undo']);

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

  for (const { pattern, action, replacement } of COMMAND_PATTERNS) {
    if (pattern.test(result)) {
      commands.push(action);
      if (META_COMMANDS.has(action)) {
        skipRefinement = true;
      }
      result = result.replace(pattern, replacement ?? '');
    }
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
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
