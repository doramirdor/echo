import { Notification } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
import { getEditLearner } from './memory/editLearner';
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
import { getProfilePrompt, detectAppProfile } from './context/appProfiles';
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

// Durable copies of recordings whose transcription failed, so audio is never
// silently lost when the speech engine is down. The normal (successful) path
// still deletes its temp WAVs — only failures land here.
const RECOVERY_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'echo', 'recordings');

/**
 * Copy a recording into the recovery folder so a failed run's audio survives the
 * pipeline's temp-file cleanup. Best-effort: returns the saved path, or null if
 * there was nothing to save (no real recording) or the copy failed.
 */
function preserveRecording(wavPath: string | undefined): string | null {
  try {
    if (!wavPath || !fs.existsSync(wavPath)) return null;
    // A header-only WAV (<=44 bytes) captured no audio — nothing worth keeping.
    if (fs.statSync(wavPath).size <= 44) return null;
    fs.mkdirSync(RECOVERY_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(RECOVERY_DIR, `recording-${stamp}.wav`);
    fs.copyFileSync(wavPath, dest);
    logger.info('pipeline', `Saved unrecovered recording to ${dest}`);
    return dest;
  } catch (err) {
    logger.warn('pipeline', `Failed to preserve recording: ${(err as Error).message}`);
    return null;
  }
}

/**
 * A transcription error worth retrying (transient) vs. one that won't get better
 * on a second attempt (bad/missing API key, engine not installed). For the
 * latter we skip straight to the local-whisper fallback.
 */
function isRetryableSttError(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes('401') || lower.includes('403') || lower.includes('invalid api key') || lower.includes('api key')) {
    return false;
  }
  if (lower.includes('not found') || lower.includes('not ready') || lower.includes('not configured') || lower.includes('not set up')) {
    return false;
  }
  return true;
}

/**
 * Transcribe with resilience: retry the configured engine once on a transient
 * failure, then — if it still fails and isn't already local whisper — fall back
 * to local whisper.cpp (when it's installed) so a cloud/engine outage doesn't
 * lose the dictation. Returns which engine actually produced the text.
 */
async function transcribeWithFallback(
  sttEngine: string,
  cleanPath: string,
  wavPath: string,
  whisper: WhisperService,
  macosSTT: MacOSTranscriber,
  opts: { language?: string; biasPrompt?: string },
): Promise<{ text: string; segments: TranscriptionSegment[]; engineUsed: string }> {
  const attempt = () => transcribeAudio(sttEngine, cleanPath, wavPath, whisper, macosSTT, opts);

  let primaryErr: Error;
  try {
    return { ...(await attempt()), engineUsed: sttEngine };
  } catch (err) {
    primaryErr = err as Error;
    logger.warn('pipeline', `STT engine ${sttEngine} failed: ${primaryErr.message}`);
    // One quick retry for transient failures (network blip, warm-server hiccup).
    if (isRetryableSttError(primaryErr.message)) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        logger.info('pipeline', `Retrying ${sttEngine}...`);
        return { ...(await attempt()), engineUsed: sttEngine };
      } catch (retryErr) {
        primaryErr = retryErr as Error;
        logger.warn('pipeline', `Retry of ${sttEngine} failed: ${primaryErr.message}`);
      }
    }
  }

  // Fall back to local whisper.cpp — but only if it's a different engine and
  // actually usable (binary + model present); otherwise there's nothing to fall
  // back to and we surface the original error.
  if (sttEngine !== 'whisper') {
    const ready = whisper.isReady(getSetting('whisperModelName'));
    if (ready.binary && ready.model) {
      logger.warn('pipeline', `Falling back to local whisper after ${sttEngine} failed`);
      new Notification({
        title: 'Echo',
        body: `${sttEngine} transcription failed — using local Whisper instead`,
        silent: true,
      }).show();
      try {
        // whisper transcribes the raw WAV (it doesn't use the cleaned upload file).
        const result = await transcribeAudio('whisper', wavPath, wavPath, whisper, macosSTT, opts);
        return { ...result, engineUsed: 'whisper' };
      } catch (fallbackErr) {
        logger.error('pipeline', `Local whisper fallback also failed: ${(fallbackErr as Error).message}`);
        // Surface the fallback error — it's the actionable one (e.g. model issue).
        throw fallbackErr;
      }
    }
    logger.warn('pipeline', 'Local whisper not available for fallback (build/download it in Settings)');
  }

  throw primaryErr;
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
  let wavPath: string | undefined;
  let cleanPath: string | undefined;

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
    wavPath = await recorder.stop();

    // 2. Clean audio + Transcribe. The sox passes (noise reduction / gain) only
    // feed the engines that consume the cleaned file — local whisper and macOS
    // Speech transcribe the raw WAV, so for them post-processing would be pure
    // wasted latency on the hot path (up to 3 blocking sox spawns).
    const usesCleanAudio = sttEngine === 'groq' || sttEngine === 'deepgram' || sttEngine === 'openai-whisper';
    cleanPath = usesCleanAudio
      ? recorder.postProcess(wavPath, {
          noiseReduction: getSetting('noiseReduction'),
          whisperMode: getSetting('whisperMode'),
        })
      : wavPath;
    logger.info('pipeline', `Transcribing with ${sttEngine}...`);

    // Bias recognition toward known vocabulary, learned corrections, and project
    // jargon. This fixes terms *during* transcription — before the LLM runs.
    const biasPrompt = buildSpeechBiasPrompt({
      vocabularyList: getSetting('vocabularyList'),
      memoryEntries: memory.getAll(),
      projectContext,
      projectTerms: CodebaseAnalyzer.loadJargonTerms(),
    });

    const { text: rawText, segments, engineUsed } = await transcribeWithFallback(
      sttEngine, cleanPath, wavPath, whisper, macosSTT,
      { language: getSetting('transcriptionLanguage'), biasPrompt },
    );
    if (engineUsed !== sttEngine) {
      logger.info('pipeline', `Transcribed via fallback engine: ${engineUsed}`);
    }

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

    // Process voice commands. Enable the code-dictation grammar only in code/shell
    // contexts so spoken symbols/case transforms never fire in prose, email, or chat.
    // When an LLM refiner will run, scratch/undo phrases are left for it (its base
    // prompt implements self-correction); the deterministic layer only takes them
    // when no refiner is configured.
    const activeProfile = detectAppProfile(appState.sourceApp);
    const refinerConfigured = getSetting('refinementEnabled') && llmProvider !== 'none';
    const voiceResult = processVoiceCommands(cleaned, getSetting('voiceCommandsEnabled'), {
      codeSymbols: activeProfile === 'coding' || activeProfile === 'shell',
      refinerAvailable: refinerConfigured,
    });
    cleaned = voiceResult.text;

    if (!cleaned) {
      logger.info('pipeline', 'Empty/blank transcription, skipping');
      if (liveInjectedText) {
        // Live preview text is already on screen; keep it, but make the undo
        // hotkey able to revert exactly that text.
        appState.setLastInsertion(liveInjectedText, appState.sourceApp);
      } else if (voiceResult.commands.length === 0) {
        new Notification({ title: 'Echo', body: 'No speech detected', silent: true }).show();
      }
      getRunLog().add({
        rawTranscription: rawText,
        refinedText: '',
        context: '',
        sourceApp: appState.sourceApp || undefined,
        sttEngine: engineUsed,
        llmProvider,
        durationMs: Date.now() - pipelineStart,
      });
      appState.setState(EchoState.Idle);
      return;
    }

    // 3. Refine with LLM (if enabled, configured, and not skipped by voice command)
    let refinedText = cleaned;
    let refiner: LLMRefiner | null = null;
    if (!voiceResult.skipRefinement && getSetting('refinementEnabled')) {
      try {
        refiner = createRefiner();
      } catch (createErr) {
        // A missing API key must not discard a successfully transcribed dictation.
        logger.warn('pipeline', `Refiner unavailable, inserting raw: ${(createErr as Error).message}`);
        new Notification({
          title: 'Echo',
          body: 'LLM not configured — inserted the raw transcript (check Settings)',
          silent: true,
        }).show();
      }
    }

    // What is currently shown in the target app and will be replaced by the
    // refined text. Starts as whatever was injected live during recording.
    let injectedText = liveInjectedText;
    // Continuation prefix for joining onto text already in the field. The live
    // path applies the same join to its first chunk, so this stays valid for
    // the final replacement in both paths.
    const continuationBefore = appState.existingFieldText || '';

    // Replace what's on screen with `finalText`, selecting/pasting only the
    // suffix that actually differs (code-point prefix diff) — select-back is
    // one key event per character, so shorter selections are much faster.
    const replaceInjected = async (finalText: string): Promise<void> => {
      const injectedCp = Array.from(injectedText);
      const finalCp = Array.from(finalText);
      let prefixLen = 0;
      while (
        prefixLen < injectedCp.length &&
        prefixLen < finalCp.length &&
        injectedCp[prefixLen] === finalCp[prefixLen]
      ) {
        prefixLen++;
      }
      const selectCount = injectedCp.length - prefixLen;
      const suffix = finalCp.slice(prefixLen).join('');
      if (selectCount === 0 && !suffix) {
        logger.info('pipeline', 'Refined text matches what is already inserted — leaving as-is');
      } else if (selectCount === 0) {
        logger.info('pipeline', `Appending: "${suffix}"`);
        await inserter.insertLive(suffix, appState.sourceApp);
      } else {
        logger.info('pipeline', `Inserting: "${finalText}"`);
        await inserter.replaceLiveText(suffix, selectCount, appState.sourceApp);
      }
      injectedText = finalText;
    };

    let instantInsert: Promise<void> | null = null;
    const awaitInstantInsert = async (): Promise<void> => {
      if (instantInsert) {
        await instantInsert;
        instantInsert = null;
      }
    };

    if (refiner) {
      appState.setState(EchoState.Refining);

      // Instant feedback (Wispr-style): if nothing has been injected yet, insert
      // the raw transcript now — concurrently with preparing the refinement —
      // and swap in the refined version once it lands. Targets the source app
      // explicitly: the user may have switched apps since recording stopped.
      if (!injectedText) {
        const early = continuationBefore ? joinContinuation(continuationBefore, cleaned) : cleaned;
        instantInsert = inserter.insertLive(early, appState.sourceApp).then((ok) => {
          if (ok) injectedText = early;
        });
      }

      const relevant = memory.findRelevant(cleaned);
      const formatted = memory.formatForPrompt(relevant);

      // Preferences learned from the user's own edits to previously inserted text.
      const editCorrections = getSetting('learnFromEdits')
        ? getEditLearner().formatForPrompt()
        : '';

      if (appState.contextPromise) {
        // Bounded wait: heavy context synthesis (vision) must not stall the
        // pipeline — past the budget, fall back to cheap window metadata.
        const budgetMs = getSetting('contextProvider') !== 'none' ? 4000 : 1500;
        try {
          const synthesized = await Promise.race([
            appState.contextPromise,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetMs)),
          ]);
          if (synthesized !== null) {
            windowContextStr = synthesized;
          } else {
            logger.warn('pipeline', `Context synthesis exceeded ${budgetMs}ms, using window metadata`);
            if (appState.contextFallbackPromise) {
              windowContextStr = await Promise.race([
                appState.contextFallbackPromise,
                new Promise<string>((resolve) => setTimeout(() => resolve(''), 250)),
              ]);
            }
          }
        } catch (err) {
          logger.warn('pipeline', `Context synthesis failed: ${(err as Error).message}`);
        }
        appState.contextPromise = null;
        appState.contextFallbackPromise = null;
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
          editCorrections,
        });

        refinedText = sanitizeRefinedOutput(refinedText);

        // The instant insert ran concurrently with refinement — settle it
        // before reading injectedText below.
        await awaitInstantInsert();

        if (refinedText === 'EMPTY' || !refinedText) {
          logger.info('pipeline', 'LLM returned EMPTY, skipping insertion');
          // Remove anything we optimistically injected for instant feedback.
          if (injectedText) {
            await inserter.replaceLiveText('', Array.from(injectedText).length, appState.sourceApp);
          }
          appState.clearLastInsertion();
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

    await awaitInstantInsert();

    // Grammar validation pass, shared by both insertion paths below.
    const runGrammarPass = async (): Promise<void> => {
      if (!(refiner && getSetting('grammarCheck') && refinedText !== cleaned)) return;
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
    };

    // 4. Insert refined text
    appState.setState(EchoState.Inserting);

    // The exact string that ends up in the field — snapshotted below so the next
    // dictation can detect how the user edited it.
    let insertedFinal: string;
    if (injectedText) {
      // Text is already on screen: replace it with the refined version NOW, then
      // run the grammar pass and patch on-screen only if it changed something —
      // the user sees the refined text one LLM round-trip sooner, and the common
      // no-change grammar result costs no extra paste.
      const finalText = continuationBefore ? joinContinuation(continuationBefore, refinedText) : refinedText;
      await replaceInjected(finalText);
      insertedFinal = finalText;

      const beforeGrammar = refinedText;
      await runGrammarPass();
      if (refinedText !== beforeGrammar) {
        const patched = continuationBefore ? joinContinuation(continuationBefore, refinedText) : refinedText;
        await replaceInjected(patched);
        insertedFinal = patched;
      }
    } else {
      // Fresh insert (nothing on screen): grammar-check first — insertion here
      // is append-only, so there is no cheap way to patch afterwards.
      await runGrammarPass();
      const textToInsert = continuationBefore ? joinContinuation(continuationBefore, refinedText) : refinedText;
      logger.info('pipeline', `Inserting: "${textToInsert}"`);
      await inserter.insert(textToInsert, appState.sourceApp);
      insertedFinal = textToInsert;
    }

    appState.setTranscription(rawText, refinedText);

    logger.info('pipeline', 'Done');
    appState.setState(EchoState.Idle);

    // Record the insertion so the undo hotkey can revert exactly this text.
    appState.setLastInsertion(insertedFinal, appState.sourceApp);

    // Remember what we inserted (and the field text around it) so the *next*
    // dictation can diff it against the user's hand-edits and learn corrections.
    if (getSetting('learnFromEdits')) {
      getEditLearner().recordInsertion({
        inserted: insertedFinal,
        beforeAnchor: appState.existingFieldText || '',
        afterAnchor: appState.existingFieldTextAfter || '',
      });
    }

    // Auto vocabulary learning
    getVocabularyLearner(memory).analyze(cleaned, refinedText);

    getRunLog().add({
      rawTranscription: rawText,
      refinedText,
      context: windowContextStr,
      sourceApp: appState.sourceApp || undefined,
      sttEngine: engineUsed,
      llmProvider,
      durationMs: Date.now() - pipelineStart,
    });

    new Notification({
      title: 'Echo',
      body: refinedText.length > 80 ? refinedText.substring(0, 80) + '...' : refinedText,
      silent: true,
    }).show();
  } catch (err) {
    // If anything threw before the recorder was stopped (e.g. a pre-flight
    // check), the native record process would keep the mic hot forever and
    // every subsequent start would fail with "Already recording". Idempotent —
    // no-ops when the recorder already stopped normally.
    recorder.forceStop();

    const message = toUserFacingError(err);
    logger.error('pipeline', `ERROR: ${message}`);

    // The speech engine (and any fallback) failed — keep the audio so the user
    // can recover it instead of losing what they said. The finally block still
    // clears the temp WAVs; this copies to a durable recovery folder first.
    const savedPath = preserveRecording(wavPath);

    // Nothing reliably landed — don't let undo delete unrelated text.
    appState.clearLastInsertion();
    appState.setState(EchoState.Error, message);

    getRunLog().add({
      rawTranscription: '',
      refinedText: '',
      context: windowContextStr,
      sourceApp: appState.sourceApp || undefined,
      sttEngine,
      llmProvider,
      durationMs: Date.now() - pipelineStart,
      error: savedPath ? `${message} (recording saved to ${savedPath})` : message,
    });

    new Notification({
      title: 'Echo — Error',
      body: savedPath
        ? `${message.length > 80 ? message.substring(0, 80) + '...' : message} — recording saved`
        : (message.length > 100 ? message.substring(0, 100) + '...' : message),
    }).show();

    setTimeout(() => {
      if (appState.state === EchoState.Error) {
        appState.setState(EchoState.Idle);
      }
    }, 3000);
  } finally {
    // Recordings are transient: delete the temp WAVs (raw, cleaned, denoised
    // intermediate) whether the pipeline succeeded or failed — they leak both
    // disk space and, more importantly, audio of everything ever dictated.
    const denoisedPath = wavPath?.replace('.wav', '-denoised.wav');
    for (const p of [cleanPath !== wavPath ? cleanPath : undefined, denoisedPath, wavPath]) {
      if (!p) continue;
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch { /* best-effort temp cleanup */ }
    }
    // Live/instant injection may have replaced the user's clipboard — put the
    // pre-dictation clipboard back (no-op when nothing was injected).
    void inserter.restoreUserClipboard();
  }
}

// Export for testing
export { createRefiner, getRunLog, templateStore, transcribeWithFallback, isRetryableSttError, preserveRecording };
