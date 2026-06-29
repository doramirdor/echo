import { Notification } from 'electron';
import * as fs from 'fs';
import { AppState, EchoState } from './appState';
import { AudioRecorder } from './audio/recorder';
import { WhisperService } from './transcription/whisperService';
import { MacOSTranscriber } from './transcription/macosTranscriber';
import { GroqTranscriber } from './transcription/groqTranscriber';
import { DeepgramTranscriber, TranscriptionSegment } from './transcription/deepgramTranscriber';
import { OpenAIWhisperTranscriber } from './transcription/openaiWhisperTranscriber';
import { TextInserter } from './insertion/textInserter';
import { MemoryStore } from './memory/memoryStore';
import { VocabularyLearner } from './memory/vocabularyLearner';
import { CLIRefiner } from './refinement/cliRefiner';
import { OllamaRefiner } from './refinement/ollamaRefiner';
import { ClaudeRefiner } from './refinement/claudeRefiner';
import { OpenAIRefiner } from './refinement/openaiRefiner';
import { GeminiRefiner } from './refinement/geminiRefiner';
import { BedrockRefiner } from './refinement/bedrockRefiner';
import { GroqRefiner } from './refinement/groqRefiner';
import { LlamaLocalRefiner } from './refinement/llamaRefiner';
import { LLMRefiner, sanitizeRefinedOutput, GRAMMAR_VALIDATION_PROMPT, detectContentType } from './refinement/refiner';
import { getSetting } from './settings/settings';
import { captureWindowContext, formatWindowContext } from './context/windowContext';
import { getProfilePrompt } from './context/appProfiles';
import { buildDictationContext } from './context/dictationContext';
import { processVoiceCommands } from './voice/voiceCommands';
import { TemplateStore } from './templates/templateStore';
import { RunLog } from './history/runLog';
import { sendConfidenceSegments } from './overlay';
import { logger } from './utils/logger';
import { toUserFacingError } from './utils/errors';
import { buildSpeechBiasPrompt } from './transcription/speechBias';
import { joinContinuation } from './insertion/continuation';
import { CodebaseAnalyzer } from './codebase/analyzer';

function createRefiner(): LLMRefiner | null {
  const provider = getSetting('llmProvider');
  switch (provider) {
    case 'claude-cli':
      return new CLIRefiner('claude');
    case 'codex-cli':
      return new CLIRefiner('codex');
    case 'claude-api': {
      const key = getSetting('claudeApiKey');
      if (!key) throw new Error('Claude API key not configured');
      return new ClaudeRefiner(key, getSetting('claudeApiModel'));
    }
    case 'openai-api': {
      const key = getSetting('openaiApiKey');
      if (!key) throw new Error('OpenAI API key not configured');
      return new OpenAIRefiner(key, getSetting('openaiApiModel'));
    }
    case 'groq': {
      const key = getSetting('groqApiKey');
      if (!key) throw new Error('Groq API key not configured');
      return new GroqRefiner(key, getSetting('groqLlmModel'));
    }
    case 'gemini': {
      const key = getSetting('geminiApiKey');
      if (!key) throw new Error('Gemini API key not configured');
      return new GeminiRefiner(key, getSetting('geminiModel'));
    }
    case 'bedrock': {
      const accessKeyId = getSetting('bedrockAccessKeyId');
      const secretAccessKey = getSetting('bedrockSecretAccessKey');
      if (!accessKeyId || !secretAccessKey) throw new Error('AWS credentials for Bedrock not configured');
      return new BedrockRefiner(accessKeyId, secretAccessKey, getSetting('bedrockRegion'), getSetting('bedrockModel'));
    }
    case 'ollama':
      return new OllamaRefiner(getSetting('ollamaEndpoint'), getSetting('ollamaModel'));
    case 'llama-local':
      return new LlamaLocalRefiner(getSetting('llamaEndpoint'), getSetting('llamaModel'));
    case 'none':
    default:
      return null;
  }
}

let runLog: RunLog | null = null;
function getRunLog(): RunLog {
  if (!runLog) runLog = new RunLog();
  return runLog;
}

let vocabularyLearner: VocabularyLearner | null = null;
function getVocabularyLearner(memory: MemoryStore): VocabularyLearner {
  if (!vocabularyLearner) vocabularyLearner = new VocabularyLearner(memory);
  return vocabularyLearner;
}

const templateStore = new TemplateStore();

async function transcribeAudio(
  sttEngine: string,
  cleanPath: string,
  wavPath: string,
  whisper: WhisperService,
  macosSTT: MacOSTranscriber,
  opts?: { language?: string; biasPrompt?: string },
): Promise<{ text: string; segments: TranscriptionSegment[] }> {
  if (sttEngine === 'groq') {
    const groq = new GroqTranscriber(getSetting('groqApiKey'));
    // Compress the upload (FLAC by default) to cut upload bytes.
    const uploadPath = AudioRecorder.encodeForUpload(cleanPath);
    try {
      const text = await groq.transcribe(uploadPath, { prompt: opts?.biasPrompt, language: opts?.language });
      return { text, segments: [] };
    } finally {
      // Clean up the encoded temp file (mirrors the Rust pipeline).
      if (uploadPath !== cleanPath) {
        try { fs.unlinkSync(uploadPath); } catch { /* best-effort temp cleanup */ }
      }
    }
  }
  if (sttEngine === 'macos') {
    const text = await macosSTT.transcribe(wavPath);
    return { text, segments: [] };
  }
  if (sttEngine === 'deepgram') {
    const dg = new DeepgramTranscriber(getSetting('deepgramApiKey'));
    const result = await dg.transcribeWithConfidence(cleanPath);
    return { text: result.text, segments: result.segments };
  }
  if (sttEngine === 'openai-whisper') {
    const oai = new OpenAIWhisperTranscriber(getSetting('openaiApiKey'), getSetting('openaiWhisperModel'));
    const result = await oai.transcribeWithConfidence(cleanPath, { prompt: opts?.biasPrompt });
    return { text: result.text, segments: result.segments };
  }
  // Local whisper.cpp (default, free). Bias decoding toward the user's jargon
  // and use the configured language for better accent handling.
  const text = await whisper.transcribe(wavPath, getSetting('whisperModelName'), {
    language: opts?.language,
    prompt: opts?.biasPrompt,
  });
  return { text, segments: [] };
}

export async function runPipeline(
  appState: AppState,
  recorder: AudioRecorder,
  whisper: WhisperService,
  macosSTT: MacOSTranscriber,
  inserter: TextInserter,
  memory: MemoryStore,
  liveInjectedText: string = '',
): Promise<void> {
  const pipelineStart = Date.now();
  const sttEngine = getSetting('sttEngine');
  const llmProvider = getSetting('llmProvider');
  let windowContextStr = '';

  // Project jargon scanned from the user's codebase — used to bias both STT and
  // LLM refinement so domain terms come out spelled correctly.
  const projectContext = CodebaseAnalyzer.loadContext() ?? undefined;

  try {
    // Pre-flight checks
    const soxCheck = AudioRecorder.checkDependencies();
    if (!soxCheck.ok) throw new Error(soxCheck.message);

    if (sttEngine === 'whisper') {
      const whisperCheck = whisper.isReady(getSetting('whisperModelName'));
      if (!whisperCheck.binary) throw new Error('Whisper binary not found. Build it in Settings.');
      if (!whisperCheck.model) throw new Error('Whisper model not downloaded. Download it in Settings.');
    }

    // 1. Stop recording
    appState.setState(EchoState.Transcribing);
    const wavPath = await recorder.stop();

    // 2. Clean audio + Transcribe
    const cleanPath = recorder.postProcess(wavPath, {
      noiseReduction: getSetting('noiseReduction'),
      whisperMode: getSetting('whisperMode'),
    });
    logger.info('pipeline', `Transcribing with ${sttEngine}...`);

    // Bias recognition toward known vocabulary, learned corrections, and project
    // jargon. This fixes terms *during* transcription — before the LLM runs.
    const biasPrompt = buildSpeechBiasPrompt({
      vocabularyList: getSetting('vocabularyList'),
      memoryEntries: memory.getAll(),
      projectContext,
    });

    const { text: rawText, segments } = await transcribeAudio(
      sttEngine, cleanPath, wavPath, whisper, macosSTT,
      { language: getSetting('transcriptionLanguage'), biasPrompt },
    );

    // Send low-confidence segments to overlay
    const lowConfidence = segments.filter(s => s.confidence < 0.7);
    if (lowConfidence.length > 0) {
      sendConfidenceSegments(lowConfidence);
    }

    logger.info('pipeline', `RAW: "${rawText}"`);

    let cleaned = rawText.replace(/\[.*?\]/g, '').trim();

    // Check for template match
    const template = templateStore.match(cleaned);
    if (template) {
      logger.info('pipeline', `Template matched: ${template.name}`);
      cleaned = template.content;
    }

    // Process voice commands
    const voiceResult = processVoiceCommands(cleaned, getSetting('voiceCommandsEnabled'));
    cleaned = voiceResult.text;

    if (!cleaned) {
      logger.info('pipeline', 'Empty/blank transcription, skipping');
      appState.setState(EchoState.Idle);
      return;
    }

    // 3. Refine with LLM (if configured and not skipped by voice command)
    let refinedText = cleaned;
    const refiner = voiceResult.skipRefinement ? null : createRefiner();

    // What is currently shown in the target app and will be replaced by the
    // refined text. Starts as whatever was injected live during recording.
    let injectedText = liveInjectedText;
    // Continuation join only applies when we are NOT replacing live text — the
    // live path already handled spacing/capitalization while recording.
    const continuationBefore = injectedText ? '' : (appState.existingFieldText || '');

    if (refiner) {
      appState.setState(EchoState.Refining);

      // Instant feedback (Wispr-style): if nothing has been injected yet (live
      // transcription was off or silent), insert the raw transcript now and swap
      // in the refined version once it lands — rather than waiting for the LLM.
      if (!injectedText) {
        const early = continuationBefore ? joinContinuation(continuationBefore, cleaned) : cleaned;
        try {
          await inserter.insertLive(early);
          injectedText = early;
        } catch (err) {
          logger.warn('pipeline', `Instant insert failed: ${(err as Error).message}`);
        }
      }

      const relevant = memory.findRelevant(cleaned);
      const formatted = memory.formatForPrompt(relevant);

      if (appState.contextPromise) {
        try {
          windowContextStr = await appState.contextPromise;
        } catch (err) {
          logger.warn('pipeline', `Context synthesis failed: ${(err as Error).message}`);
        }
        appState.contextPromise = null;
      } else if (getSetting('useWindowContext')) {
        try {
          const winCtx = await captureWindowContext();
          windowContextStr = formatWindowContext(winCtx);
        } catch (err) {
          logger.warn('pipeline', `Window context capture failed: ${(err as Error).message}`);
        }
      }

      // Add dictation history context
      const historyContext = buildDictationContext(getRunLog());
      if (historyContext) {
        windowContextStr = windowContextStr
          ? `${windowContextStr}\n\nRecent dictations:\n${historyContext}`
          : `Recent dictations:\n${historyContext}`;
      }

      // Per-app profile prompt — passed separately so it AUGMENTS the base
      // rules instead of replacing them (a user custom prompt still replaces).
      const profilePrompt = getProfilePrompt(appState.sourceApp);
      const vocabularyList = getSetting('vocabularyList')?.trim() || '';
      const customPrompt = getSetting('customPrompt')?.trim() || '';

      const existingFieldText = appState.existingFieldText || '';
      const tone = getSetting('tone');

      // Content-aware auto-formatting: only for a fresh field (not a mid-sentence
      // continuation) and only when the user hasn't turned it off.
      const contentType = (getSetting('autoFormatContent') && !existingFieldText)
        ? detectContentType(cleaned)
        : 'default';
      if (contentType !== 'default') {
        logger.info('pipeline', `Auto-format: detected ${contentType}`);
      }

      if (existingFieldText) {
        logger.info('pipeline', `Existing field text: "${existingFieldText.substring(0, 80)}..."`);
      }

      logger.info('pipeline', `Refining with LLM... (tone: ${tone})`);
      const t0 = Date.now();
      try {
        refinedText = await refiner.refine(cleaned, {
          memoryEntries: relevant,
          memoryFormatted: formatted,
          windowContext: windowContextStr,
          vocabularyList,
          customPrompt,
          appProfilePrompt: profilePrompt,
          existingFieldText,
          existingFieldTextAfter: appState.existingFieldTextAfter || '',
          projectContext,
          tone,
          contentType,
        });

        refinedText = sanitizeRefinedOutput(refinedText);

        if (refinedText === 'EMPTY' || !refinedText) {
          logger.info('pipeline', 'LLM returned EMPTY, skipping insertion');
          // Remove anything we optimistically injected for instant feedback.
          if (injectedText) {
            await inserter.replaceLiveText('', Array.from(injectedText).length, appState.sourceApp);
          }
          appState.setState(EchoState.Idle);
          return;
        }

        logger.info('pipeline', `REFINED (${Date.now() - t0}ms): "${refinedText}"`);
        memory.markUsed(relevant.map(e => e.id));
      } catch (refineErr) {
        logger.warn('pipeline', `Refinement failed, using raw: ${(refineErr as Error).message}`);
        refinedText = cleaned;
      }
    } else {
      logger.info('pipeline', 'No LLM configured, using raw text');
    }

    // Grammar validation pass
    if (refiner && getSetting('grammarCheck') && refinedText !== cleaned) {
      try {
        const grammarResult = await refiner.refine(refinedText, {
          memoryEntries: [],
          memoryFormatted: '',
          customPrompt: GRAMMAR_VALIDATION_PROMPT,
        });
        const grammarFixed = sanitizeRefinedOutput(grammarResult);
        if (grammarFixed && grammarFixed !== 'EMPTY') {
          refinedText = grammarFixed;
        }
      } catch (grammarErr) {
        logger.warn('pipeline', `Grammar validation failed: ${(grammarErr as Error).message}`);
      }
    }

    appState.setTranscription(rawText, refinedText);

    // 4. Insert refined text
    appState.setState(EchoState.Inserting);

    if (injectedText) {
      // Replace the text already on screen (live or instant-insert) with the
      // refined version. Skip the round trip if it would be a no-op.
      const finalText = continuationBefore ? joinContinuation(continuationBefore, refinedText) : refinedText;
      if (finalText !== injectedText) {
        logger.info('pipeline', `Inserting: "${finalText}"`);
        await inserter.replaceLiveText(finalText, Array.from(injectedText).length, appState.sourceApp);
      } else {
        logger.info('pipeline', 'Refined text matches what is already inserted — leaving as-is');
      }
    } else {
      // Nothing on screen yet (no LLM and no live text): fresh insert, continuing
      // from the caret. Deterministic, so it works even with no LLM configured.
      const before = appState.existingFieldText || '';
      const textToInsert = before ? joinContinuation(before, refinedText) : refinedText;
      logger.info('pipeline', `Inserting: "${textToInsert}"`);
      await inserter.insert(textToInsert, appState.sourceApp);
    }

    logger.info('pipeline', 'Done');
    appState.setState(EchoState.Idle);

    // Auto vocabulary learning
    getVocabularyLearner(memory).analyze(cleaned, refinedText);

    getRunLog().add({
      rawTranscription: rawText,
      refinedText,
      context: windowContextStr,
      sourceApp: appState.sourceApp || undefined,
      sttEngine,
      llmProvider,
      durationMs: Date.now() - pipelineStart,
    });

    new Notification({
      title: 'Echo',
      body: refinedText.length > 80 ? refinedText.substring(0, 80) + '...' : refinedText,
      silent: true,
    }).show();
  } catch (err) {
    const message = toUserFacingError(err);
    logger.error('pipeline', `ERROR: ${message}`);

    appState.setState(EchoState.Error, message);

    getRunLog().add({
      rawTranscription: '',
      refinedText: '',
      context: windowContextStr,
      sourceApp: appState.sourceApp || undefined,
      sttEngine,
      llmProvider,
      durationMs: Date.now() - pipelineStart,
      error: message,
    });

    new Notification({
      title: 'Echo — Error',
      body: message.length > 100 ? message.substring(0, 100) + '...' : message,
    }).show();

    setTimeout(() => {
      if (appState.state === EchoState.Error) {
        appState.setState(EchoState.Idle);
      }
    }, 3000);
  }
}

// Export for testing
export { createRefiner, getRunLog, templateStore };
