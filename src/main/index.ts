import { app, globalShortcut } from 'electron';
import { exec, execFileSync } from 'child_process';
import { AppState, EchoState } from './appState';
import { AudioRecorder } from './audio/recorder';
import { WhisperService } from './transcription/whisperService';
import { MacOSTranscriber } from './transcription/macosTranscriber';
import { TextInserter } from './insertion/textInserter';
import { MemoryStore } from './memory/memoryStore';
import { LiveTranscriber } from './transcription/liveTranscriber';
import { FnKeyMonitor, FnAction } from './fnKeyMonitor';
import { getSetting } from './settings/settings';
import { runPipeline } from './pipeline';
import { captureScreenshot, captureWindowContext, captureFieldContext, formatWindowContext, cleanupScreenshot } from './context/windowContext';
import { synthesizeContext } from './context/contextSynthesizer';
import { playRecordingStart, playRecordingStop, playError } from './audio/sounds';
import { createOverlay, sendOverlayState, sendLiveTranscript, sendAudioLevel, toggleOverlay, showOverlayForActivity, hideOverlayAfterActivity } from './overlay';
import { createTray, updateTray } from './tray';
import { openSettings, showOnboarding } from './windows';
import { setupIPC } from './ipc';
import { logger } from './utils/logger';
import { toUserFacingError } from './utils/errors';
import { setupAutoUpdater } from './updater';
import { ensureSwiftBinary } from './utils/swiftBinary';

// --- Globals ---
const appState = new AppState();
const recorder = new AudioRecorder();
const whisper = new WhisperService();
const macosSTT = new MacOSTranscriber();
const inserter = new TextInserter();
const memory = new MemoryStore();
const liveTranscriber = new LiveTranscriber();
const fnKeyMonitor = new FnKeyMonitor();

// Track whether current recording was started via fn-hold (vs fn-double-click / toggle)
let fnHoldRecording = false;
// Track whether current recording was started via hotkey hold mode
let hotkeyHoldRecording = false;
// Pending start delay timer
let startDelayTimer: ReturnType<typeof setTimeout> | null = null;

// --- Live injection state ---
let liveInjectedText = '';  // full text injected so far during live recording

// --- Silence detection ---
let silenceStart: number | null = null;
let silenceTimer: ReturnType<typeof setTimeout> | null = null;
let silenceGraceTimer: ReturnType<typeof setTimeout> | null = null;

function startSilenceDetection(): void {
  if (!getSetting('silenceDetection')) return;

  silenceStart = null;
  if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }

  recorder.on('level', onSilenceLevel);
}

function stopSilenceDetection(): void {
  recorder.removeListener('level', onSilenceLevel);
  silenceStart = null;
  if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  if (silenceGraceTimer) { clearTimeout(silenceGraceTimer); silenceGraceTimer = null; }
}

function scheduleSilenceDetection(): void {
  if (silenceGraceTimer) { clearTimeout(silenceGraceTimer); silenceGraceTimer = null; }
  silenceGraceTimer = setTimeout(() => {
    silenceGraceTimer = null;
    if (appState.state === EchoState.Recording) {
      startSilenceDetection();
    }
  }, 1000);
}

function onSilenceLevel(level: number): void {
  const whisperMode = getSetting('whisperMode');
  // In whisper mode, use a much lower threshold so quiet speech isn't mistaken for silence
  const threshold = whisperMode
    ? Math.min(getSetting('silenceThreshold'), 0.005)
    : getSetting('silenceThreshold');
  const duration = getSetting('silenceDuration');

  if (level < threshold) {
    if (silenceStart === null) {
      silenceStart = Date.now();
      silenceTimer = setTimeout(() => {
        if (appState.state === EchoState.Recording) {
          console.log(`[echo] Silence detected (${duration}ms), auto-stopping`);
          fnHoldRecording = false;
          stopRecording();
        }
      }, duration);
    }
  } else {
    silenceStart = null;
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  }
}

// --- Hold-to-talk key release detection ---
let holdPollTimer: ReturnType<typeof setInterval> | null = null;

function startHoldDetection(): void {
  if (holdPollTimer) return; // prevent double-start
  // Poll modifier keys every 100ms — when all modifiers are released, stop recording
  holdPollTimer = setInterval(() => {
    try {
      const result = execFileSync('osascript', [
        '-e', 'use framework "AppKit"',
        '-e', 'set f to (current application\'s NSEvent\'s modifierFlags()) as integer',
        '-e', 'set m to f div 131072 mod 16',
        '-e', 'if m = 0 then return "false"',
        '-e', 'return "true"',
      ], { encoding: 'utf-8', timeout: 500, stdio: 'pipe' }).trim();

      if (result === 'false') {
        stopHoldDetection();
        if (appState.state === EchoState.Recording && (hotkeyHoldRecording || getSetting('recordingMode') === 'hold')) {
          hotkeyHoldRecording = false;
          fnHoldRecording = false;
          stopRecording();
        }
      }
    } catch {
      stopHoldDetection();
    }
  }, 100);
}

function stopHoldDetection(): void {
  if (holdPollTimer) {
    clearInterval(holdPollTimer);
    holdPollTimer = null;
  }
}

// --- Toggle Recording (fallback hotkey) ---
function toggle(): void {
  const mode = getSetting('recordingMode');

  if (mode === 'hold') {
    // In hold mode, hotkey down starts recording; release is handled by hold detection
    if (appState.state === EchoState.Idle || appState.state === EchoState.Error) {
      fnHoldRecording = false;
      hotkeyHoldRecording = true;
      beginRecordingWithDelay();
      startHoldDetection();
    }
    return;
  }

  // Toggle mode
  if (appState.state === EchoState.Recording) {
    fnHoldRecording = false;
    hotkeyHoldRecording = false;
    stopRecording();
  } else if (appState.state === EchoState.Idle || appState.state === EchoState.Error) {
    fnHoldRecording = false;
    hotkeyHoldRecording = false;
    beginRecordingWithDelay();
  }
}

// --- fn key actions ---
function handleFnAction(action: FnAction): void {
  switch (action) {
    case 'hold-start':
      if (appState.state === EchoState.Idle || appState.state === EchoState.Error) {
        fnHoldRecording = true;
        hotkeyHoldRecording = false;
        beginRecordingWithDelay();
      }
      break;

    case 'hold-end':
      if (appState.state === EchoState.Recording && fnHoldRecording) {
        fnHoldRecording = false;
        stopRecording();
      }
      break;

    case 'double-click':
      if (appState.state === EchoState.Idle || appState.state === EchoState.Error) {
        fnHoldRecording = false;
        hotkeyHoldRecording = false;
        beginRecordingWithDelay();
      } else if (appState.state === EchoState.Recording && !fnHoldRecording) {
        stopRecording();
      }
      break;

    case 'single-click':
      // Single fn tap stops toggle recording (if recording via double-click)
      if (appState.state === EchoState.Recording && !fnHoldRecording) {
        stopRecording();
      }
      break;
  }
}

function beginRecordingWithDelay(): void {
  const delay = getSetting('startDelay') || 0;
  if (startDelayTimer) {
    clearTimeout(startDelayTimer);
    startDelayTimer = null;
  }
  if (delay > 0) {
    logger.info('echo', `Starting recording in ${delay}ms`);
    startDelayTimer = setTimeout(() => {
      startDelayTimer = null;
      if (appState.state === EchoState.Idle || appState.state === EchoState.Error) {
        startRecording();
      }
    }, delay);
    return;
  }
  startRecording();
}

function cancelPendingStart(): void {
  if (startDelayTimer) {
    clearTimeout(startDelayTimer);
    startDelayTimer = null;
  }
}

function startRecording(): void {
  appState.sourceApp = null;
  exec(
    `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`,
    { encoding: 'utf-8', timeout: 2000 },
    (err, stdout) => {
      if (!err && stdout) {
        appState.sourceApp = stdout.trim();
        console.log(`[echo] Source app: ${appState.sourceApp}`);
      }
    }
  );

  try {
    liveInjectedText = '';
    recorder.levelBoost = getSetting('whisperMode') ? 10 : 3;
    recorder.start(getSetting('audioDevice') || undefined);
    liveTranscriber.start();
    appState.setState(EchoState.Recording);
    playRecordingStart();

    appState.existingFieldText = null;
    appState.existingFieldTextAfter = null;

    // Capture text around the caret (accurate, caret-aware) for sentence
    // continuation. Fast and independent of the heavier context synthesis below.
    captureFieldContext()
      .then((fc) => {
        appState.existingFieldText = fc.before || null;
        appState.existingFieldTextAfter = fc.after || null;
        if (fc.before || fc.after) {
          console.log(`[echo] Caret context: ${fc.before.length} before, ${fc.after.length} after`);
        }
      })
      .catch(() => { /* continuation is best-effort */ });

    if (getSetting('useWindowContext')) {
      const contextProvider = getSetting('contextProvider');
      if (contextProvider !== 'none') {
        appState.contextPromise = (async () => {
          try {
            const captureScreenshotsEnabled = getSetting('captureScreenshots');
            const [winCtx, screenshotPath] = await Promise.all([
              captureWindowContext(),
              captureScreenshotsEnabled ? captureScreenshot() : Promise.resolve(null),
            ]);
            const apiKey = contextProvider === 'claude'
              ? getSetting('claudeApiKey')
              : getSetting('groqApiKey');
            const result = await synthesizeContext(winCtx, screenshotPath ?? undefined, contextProvider, apiKey);
            if (screenshotPath) cleanupScreenshot(screenshotPath);
            return result;
          } catch (err) {
            console.warn('[echo] Parallel context synthesis failed:', (err as Error).message);
            return '';
          }
        })();
      } else {
        appState.contextPromise = captureWindowContext()
          .then((winCtx) => formatWindowContext(winCtx))
          .catch(() => '');
      }
    } else {
      // Caret context for continuation is captured separately above.
      appState.contextPromise = null;
    }

    const sourceApp = appState.sourceApp as string | null;
    if (sourceApp) {
      const escaped = sourceApp.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      execFileSync('osascript', ['-e', `tell application "${escaped}" to activate`], { timeout: 2000 });
    }

    if (getSetting('silenceDetection')) {
      scheduleSilenceDetection();
    }
  } catch (err) {
    const message = toUserFacingError(err);
    logger.error('echo', `Recording start failed: ${message}`);
    appState.setState(EchoState.Error, message);
  }
}

function stopRecording(): void {
  cancelPendingStart();
  stopSilenceDetection();
  stopHoldDetection();
  hotkeyHoldRecording = false;
  playRecordingStop();
  liveTranscriber.stop();
  runPipeline(appState, recorder, whisper, macosSTT, inserter, memory, liveInjectedText);
}

// --- App Lifecycle ---
app.dock?.hide();

app.whenReady().then(() => {
  createTray(appState, toggle, openSettings);
  createOverlay();

  // Update tray + overlay on state changes
  appState.on('stateChange', (state: string) => {
    if (state === EchoState.Error) playError();
    updateTray(appState, toggle, openSettings);
    sendOverlayState(appState.state, {
      lastResult: appState.lastRefinedText?.substring(0, 60) ?? undefined,
      rawResult: appState.lastTranscription ?? undefined,
      error: appState.errorMessage ?? undefined,
    });

    // Auto-show overlay when recording starts, auto-hide when idle
    if (state === EchoState.Recording) {
      showOverlayForActivity();
    } else if (state === EchoState.Idle) {
      hideOverlayAfterActivity();
    }
  });

  // Forward live transcription to overlay + inject finals into target app
  liveTranscriber.on('partial', (text: string) => sendLiveTranscript(text));
  liveTranscriber.on('final', async (text: string) => {
    sendLiveTranscript(text);
    if (appState.state === EchoState.Recording && text.trim()) {
      const newText = text.trim();
      const separator = liveInjectedText ? ' ' : '';
      await inserter.insertLive(separator + newText);
      liveInjectedText += separator + newText;
      console.log(`[echo] Live injected: "${newText}" (total: ${liveInjectedText.length} chars)`);
    }
  });

  // Forward audio levels to overlay for waveform visualization
  recorder.on('level', (level: number) => sendAudioLevel(level));

  // Start fn key monitor (primary hotkey)
  fnKeyMonitor.on('action', handleFnAction);
  fnKeyMonitor.start();
  console.log('[echo] fn key monitor started');

  // Register fallback global hotkeys
  const hotkey = getSetting('hotkey');
  const registered = globalShortcut.register(hotkey, toggle);
  if (!registered) {
    console.error(`[echo] Failed to register hotkey: ${hotkey}`);
  } else {
    console.log(`[echo] Fallback hotkey registered: ${hotkey}`);
  }

  const overlayHotkey = getSetting('overlayHotkey');
  const overlayRegistered = globalShortcut.register(overlayHotkey, toggleOverlay);
  if (!overlayRegistered) {
    console.error(`[echo] Failed to register overlay hotkey: ${overlayHotkey}`);
  } else {
    console.log(`[echo] Overlay hotkey registered: ${overlayHotkey}`);
  }

  setupIPC(appState, whisper, memory, toggle, inserter, recorder, liveTranscriber,
    () => ({ ok: fnKeyMonitor.inputMonitoring === 'granted', status: fnKeyMonitor.inputMonitoring }));

  // Pre-compile Swift binaries in background
  ensureSwiftBinary('fn-monitor', 'scripts/fn-monitor.swift');
  ensureSwiftBinary('live-transcribe', 'scripts/live-transcribe.swift');
  ensureSwiftBinary('transcribe', 'scripts/transcribe.swift');
  ensureSwiftBinary('field-context', 'scripts/field-context.swift');

  // Auto-update (packaged builds only)
  setupAutoUpdater();

  // Check dependencies
  const soxCheck = AudioRecorder.checkDependencies();
  if (!soxCheck.ok) logger.warn('echo', soxCheck.message ?? 'SoX not found');

  const whisperCheck = whisper.isReady();
  if (!whisperCheck.binary || !whisperCheck.model) {
    logger.warn('echo', 'Whisper not ready. Run: npm run setup');
  }

  const axCheck = TextInserter.checkPermissions();
  if (!axCheck.ok) logger.warn('echo', axCheck.message ?? 'Accessibility not granted');

  app.setLoginItemSettings({ openAtLogin: getSetting('openAtLogin') });

  if (!getSetting('onboardingComplete')) {
    showOnboarding();
  }

  console.log('[echo] Ready! Press', hotkey, 'to toggle recording.');
});

// --- Crash Failsafe ---
let isShuttingDown = false;

app.on('before-quit', () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[echo] Shutting down...');
  recorder.forceStop();
  liveTranscriber.forceStop();
  fnKeyMonitor.forceStop();
  memory.flush();
  setTimeout(() => {
    console.error('[echo] Shutdown timed out — force exiting');
    process.exit(1);
  }, 5000).unref();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // Don't quit when all windows are closed (menu bar app)
});

process.on('uncaughtException', (err) => {
  console.error('[echo] Uncaught exception:', err);
  if (!isShuttingDown) {
    appState.setState(EchoState.Error, err.message);
    setTimeout(() => {
      if (appState.state === EchoState.Error) appState.setState(EchoState.Idle);
    }, 3000);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[echo] Unhandled rejection:', reason);
  if (!isShuttingDown) {
    appState.setState(EchoState.Error, String(reason));
    setTimeout(() => {
      if (appState.state === EchoState.Error) appState.setState(EchoState.Idle);
    }, 3000);
  }
});
