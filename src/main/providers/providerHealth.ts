import { execSync } from 'child_process';
import { AudioRecorder } from '../audio/recorder';
import { TextInserter } from '../insertion/textInserter';
import { WhisperService } from '../transcription/whisperService';
import { GroqTranscriber } from '../transcription/groqTranscriber';
import { DeepgramTranscriber } from '../transcription/deepgramTranscriber';
import { OpenAIWhisperTranscriber } from '../transcription/openaiWhisperTranscriber';
import { getSetting } from '../settings/settings';

export interface ProviderStatus {
  id: string;
  label: string;
  ok: boolean;
  message: string;
}

export async function checkAllProviders(
  whisper: WhisperService,
): Promise<ProviderStatus[]> {
  const results: ProviderStatus[] = [];

  // SoX
  const sox = AudioRecorder.checkDependencies();
  results.push({ id: 'sox', label: 'SoX (audio)', ok: sox.ok, message: sox.message ?? 'OK' });

  // Accessibility
  const ax = TextInserter.checkPermissions();
  results.push({ id: 'accessibility', label: 'Accessibility', ok: ax.ok, message: ax.message ?? 'OK' });

  // Whisper local
  const whisperStatus = whisper.isReady();
  results.push({
    id: 'whisper',
    label: 'Local Whisper',
    ok: whisperStatus.binary && whisperStatus.model,
    message: !whisperStatus.binary ? 'Binary not built' : !whisperStatus.model ? 'Model not downloaded' : 'Ready',
  });

  // Groq
  const groqKey = getSetting('groqApiKey');
  if (groqKey) {
    const groq = await GroqTranscriber.validateApiKey(groqKey);
    results.push({ id: 'groq', label: 'Groq STT', ok: groq.valid, message: groq.valid ? 'API key valid' : (groq.error ?? 'Invalid') });
  }

  // Deepgram
  const dgKey = getSetting('deepgramApiKey');
  if (dgKey) {
    const dg = await DeepgramTranscriber.validateApiKey(dgKey);
    results.push({ id: 'deepgram', label: 'Deepgram STT', ok: dg.valid, message: dg.valid ? 'API key valid' : (dg.error ?? 'Invalid') });
  }

  // OpenAI Whisper
  const oaiKey = getSetting('openaiApiKey');
  if (oaiKey) {
    const oai = await OpenAIWhisperTranscriber.validateApiKey(oaiKey);
    results.push({ id: 'openai-whisper', label: 'OpenAI Whisper', ok: oai.valid, message: oai.valid ? 'API key valid' : (oai.error ?? 'Invalid') });
  }

  // Claude CLI
  results.push({
    id: 'claude-cli',
    label: 'Claude CLI',
    ok: cliExists('claude'),
    message: cliExists('claude') ? 'Installed' : 'Not found on PATH',
  });

  // Codex CLI
  results.push({
    id: 'codex-cli',
    label: 'Codex CLI',
    ok: cliExists('codex'),
    message: cliExists('codex') ? 'Installed' : 'Not found on PATH',
  });

  // Ollama
  try {
    const endpoint = getSetting('ollamaEndpoint');
    const resp = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(5000) });
    results.push({ id: 'ollama', label: 'Ollama', ok: resp.ok, message: resp.ok ? 'Running' : `HTTP ${resp.status}` });
  } catch {
    results.push({ id: 'ollama', label: 'Ollama', ok: false, message: 'Not running' });
  }

  // Llama local
  try {
    const endpoint = getSetting('llamaEndpoint');
    const resp = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5000) });
    results.push({ id: 'llama-local', label: 'Llama.cpp', ok: resp.ok, message: resp.ok ? 'Running' : `HTTP ${resp.status}` });
  } catch {
    results.push({ id: 'llama-local', label: 'Llama.cpp', ok: false, message: 'Not running' });
  }

  return results;
}

function cliExists(command: string): boolean {
  try {
    execSync(`which ${command}`, { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
