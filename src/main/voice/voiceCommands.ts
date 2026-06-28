export interface VoiceCommandResult {
  text: string;
  commands: string[];
  skipRefinement: boolean;
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
export function processVoiceCommands(text: string, enabled: boolean): VoiceCommandResult {
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

  return {
    text: result.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim(),
    commands,
    skipRefinement,
  };
}
