/**
 * Maps internal errors to user-facing messages with actionable guidance.
 */
export function toUserFacingError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (lower.includes('sox') || lower.includes('rec: command not found') || lower.includes('enoent') && lower.includes('rec')) {
    return 'SoX is not installed. Run: brew install sox';
  }
  if (lower.includes('whisper') && (lower.includes('not found') || lower.includes('not ready'))) {
    return 'Whisper is not set up. Open Settings and build/download Whisper, or run: npm run setup';
  }
  if (lower.includes('groq') && (lower.includes('api') || lower.includes('401') || lower.includes('403'))) {
    return 'Groq API key is invalid or missing. Check Settings → General → Groq API Key';
  }
  if (lower.includes('accessibility') || lower.includes('not authorized') || lower.includes('assistive')) {
    return 'Accessibility permission required. Open System Settings → Privacy & Security → Accessibility and enable Echo';
  }
  if (lower.includes('microphone') || lower.includes('audio')) {
    return 'Microphone access failed. Check System Settings → Privacy & Security → Microphone';
  }
  if (lower.includes('macos transcriber not found') || lower.includes('live-transcribe')) {
    return 'macOS speech binary not found. Restart Echo to auto-compile, or check logs';
  }
  if (lower.includes('claude api') || lower.includes('anthropic')) {
    return 'Claude API error. Check your API key in Settings → LLM';
  }
  if (lower.includes('openai api')) {
    return 'OpenAI API error. Check your API key in Settings → LLM';
  }
  if (lower.includes('ollama') || lower.includes('econnrefused') && lower.includes('11434')) {
    return 'Ollama is not running. Start it with: ollama serve';
  }
  if (lower.includes('deepgram')) {
    return 'Deepgram API error. Check your API key in Settings → General';
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'Operation timed out. Try again or check your network connection';
  }
  if (lower.includes('empty') || lower.includes('no speech')) {
    return 'No speech detected. Try speaking closer to the microphone';
  }

  return message.length > 200 ? message.substring(0, 200) + '...' : message;
}
