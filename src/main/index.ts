import { app, globalShortcut, Notification, shell } from 'electron';
import { exec, execFile } from 'child_process';
import { AppState, EchoState } from './appState';
import { AudioRecorder } from './audio/recorder';
import { WhisperService } from './transcription/whisperService';
import { MacOSTranscriber } from './transcription/macosTranscriber';
import { TextInserter } from './insertion/textInserter';
import { undoLastInsertion } from './insertion/undo';
import { joinContinuation } from './insertion/continuation';
import { MemoryStore } from './memory/memoryStore';
import { getEditLearner } from './memory/editLearner';
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
import { ensureSwiftBinaryAsync } from './utils/swiftBinary';

// --- Globals ---
const appState = new AppState();
const recorder = new AudioRecorder();
const whisper = new WhisperService();
const macosSTT = new MacOSTranscriber();
const inserter = new TextInserter();
const memory = new MemoryStore();
const liveTranscriber = new LiveTranscriber();
const fnKeyMonitor = new FnKeyMonitor();

// Track whether current recording was started via hotkey hold mode
let hotkeyHoldRecording = false;
// Pending start delay timer
let startDelayTimer: ReturnType<typeof setTimeout> | null = null;

// --- fn-key gesture state (optimistic instant-start machine) ---
// Recording begins the instant fn goes down; the press is then classified on
// release. `pending` = started, not yet classified (a hold release stops it
// immediately, so there's no persistent hold state); `handsfree` = double-click
// latched, stops on the next tap / overlay click.
type FnSessionMode = 'idle' | 'pending' | 'handsfree';
let fnSessionMode: FnSessionMode = 'idle';
let fnPressTime = 0;
let fnStrayTapTimer: ReturnType<typeof setTimeout> | null = null;
// A press held at least this long counts as real speech and is kept (push-to-talk),
// so even a quick "yes"/"no" isn't dropped. A shorter press is treated as a mistake
// — either the first half of a double-click or a stray tap to be discarded.
const FN_HOLD_MIN_MS = 100;
// How long to wait after a quick tap for a double-click before discarding the
// optimistic recording. Kept slightly above the monitor's double-click window so
// a genuine double-click always lands before the stray-tap discard fires.
const FN_TAP_RESOLVE_MS = 340;

function clearFnStrayTapTimer(): void {
  if (fnStrayTapTimer) { clearTimeout(fnStrayTapTimer); fnStrayTapTimer = null; }
}

// --- Live injection state ---
let liveInjectedText = '';  // full text injected so far during live recording
// Live injections are serialized through this chain so chunks never interleave
// and stopRecording can drain the in-flight paste before snapshotting the
// injected-char count.
let liveInjectQueue: Promise<void> = Promise.resolve();
// Reentrancy guard: a second stop trigger during the (async) stop sequence
// must not start a second pipeline.
let stopInProgress = false;

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
          void stopRecording();
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
let holdPollBusy = false;

function startHoldDetection(): void {
  if (holdPollTimer) return; // prevent double-start
  // Poll modifier keys every 100ms — when all modifiers are released, stop
  // recording. The osascript runs async so the poll never blocks the main
  // process (level events, overlay updates, live-transcript forwarding).
  holdPollTimer = setInterval(() => {
    if (holdPollBusy) return; // previous check still in flight
    holdPollBusy = true;
    execFile('osascript', [
      '-e', 'use framework "AppKit"',
      '-e', 'set f to (current application\'s NSEvent\'s modifierFlags()) as integer',
      '-e', 'set m to f div 131072 mod 16',
      '-e', 'if m = 0 then return "false"',
      '-e', 'return "true"',
    ], { encoding: 'utf-8', timeout: 500 }, (err, stdout) => {
      holdPollBusy = false;
      if (err) {
        stopHoldDetection();
        return;
      }
      if (String(stdout).trim() === 'false') {
        stopHoldDetection();
        // Released during a pending startDelay: never start the recording —
        // otherwise it would run until manually stopped.
        cancelPendingStart();
        if (appState.state === EchoState.Recording && (hotkeyHoldRecording || getSetting('recordingMode') === 'hold')) {
          hotkeyHoldRecording = false;
          void stopRecording();
        } else {
          hotkeyHoldRecording = false;
        }
      }
    });
  }, 100);
}

function stopHoldDetection(): void {
  if (holdPollTimer) {
    clearInterval(holdPollTimer);
    holdPollTimer = null;
  }
}

// --- Toggle Recording (fallback hotkey + overlay click) ---
function toggle(): void {
  // A second trigger while a delayed start is pending cancels the pending start.
  if (startDelayTimer) {
    cancelPendingStart();
    hotkeyHoldRecording = false;
    return;
  }

  // A live recording always stops on toggle — this is what powers the overlay
  // click-to-stop and the fallback hotkey, regardless of how recording was
  // started (fn hold, double-click, hotkey) or the configured recordingMode.
  if (appState.state === EchoState.Recording) {
    fnSessionMode = 'idle';
    hotkeyHoldRecording = false;
    void stopRecording();
    return;
  }

  if (appState.state !== EchoState.Idle && appState.state !== EchoState.Error) return;

  const mode = getSetting('recordingMode');
  if (mode === 'hold') {
    // In hold mode, hotkey down starts recording; release is handled by hold detection
    hotkeyHoldRecording = true;
    beginRecordingWithDelay();
    startHoldDetection();
    return;
  }

  // Toggle mode — start
  hotkeyHoldRecording = false;
  beginRecordingWithDelay();
}

// --- fn key actions ---
// Recording starts the instant fn goes down (no hold threshold), then the
// gesture is classified from how the key is released:
//   • hold ≥100ms then release  → push-to-talk: stop on release (audio kept)
//   • quick double-tap          → hands-free: latch on, stop on next tap/overlay
//   • sub-100ms tap, nothing    → stray: discard the recording (no pipeline)
function handleFnAction(action: FnAction): void {
  switch (action) {
    case 'press':
      fnPressTime = Date.now();
      clearFnStrayTapTimer();
      if (appState.state === EchoState.Recording) {
        // While latched hands-free, a press is the user stopping. Push-to-talk
        // holds ignore extra presses (there's only one physical key).
        if (fnSessionMode === 'handsfree') {
          fnSessionMode = 'idle';
          void stopRecording();
        }
        return;
      }
      if (appState.state === EchoState.Idle || appState.state === EchoState.Error) {
        fnSessionMode = 'pending';
        hotkeyHoldRecording = false;
        startRecording(); // instant — no delay/threshold
      }
      break;

    case 'release':
      if (appState.state !== EchoState.Recording || fnSessionMode !== 'pending') return;
      if (Date.now() - fnPressTime >= FN_HOLD_MIN_MS) {
        // Deliberate hold → push-to-talk stop.
        fnSessionMode = 'idle';
        void stopRecording();
      } else {
        // Quick tap: wait briefly for a double-click to latch hands-free,
        // otherwise discard the few ms of optimistically-recorded audio.
        clearFnStrayTapTimer();
        fnStrayTapTimer = setTimeout(() => {
          fnStrayTapTimer = null;
          if (appState.state === EchoState.Recording && fnSessionMode === 'pending') {
            fnSessionMode = 'idle';
            cancelRecording();
          }
        }, FN_TAP_RESOLVE_MS);
      }
      break;

    case 'double-click':
      clearFnStrayTapTimer();
      if (appState.state === EchoState.Recording) {
        if (fnSessionMode === 'pending') {
          // Upgrade the in-progress optimistic recording to hands-free.
          fnSessionMode = 'handsfree';
        } else if (fnSessionMode === 'handsfree') {
          fnSessionMode = 'idle';
          void stopRecording();
        }
      } else if (appState.state === EchoState.Idle || appState.state === EchoState.Error) {
        // Safety net (e.g. a missed first press) — start hands-free directly.
        fnSessionMode = 'handsfree';
        hotkeyHoldRecording = false;
        startRecording();
      }
      break;

    case 'combo':
      // fn was used as a modifier for another key (e.g. fn+Delete, fn+←) rather
      // than pressed on its own — discard the optimistic recording it triggered.
      // The eventual 'release' is a no-op once mode is back to 'idle'.
      clearFnStrayTapTimer();
      if (appState.state === EchoState.Recording && fnSessionMode === 'pending') {
        fnSessionMode = 'idle';
        cancelRecording();
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
        // Before overwriting, diff this fresh read against what we last inserted
        // to learn any hand-edits the user made to it (Wispr-style "learns from
        // your corrections"). Best-effort — never blocks recording.
        if (getSetting('learnFromEdits')) {
          try {
            getEditLearner().learnFromField({ before: fc.before, after: fc.after });
          } catch (err) {
            logger.warn('echo', `Edit learning failed: ${(err as Error).message}`);
          }
        }
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
        // Cheap metadata fallback, used if heavy synthesis blows its budget.
        appState.contextFallbackPromise = captureWindowContext()
          .then((winCtx) => formatWindowContext(winCtx))
          .catch(() => '');
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
        appState.contextFallbackPromise = null;
        appState.contextPromise = captureWindowContext()
          .then((winCtx) => formatWindowContext(winCtx))
          .catch(() => '');
      }
    } else {
      // Caret context for continuation is captured separately above.
      appState.contextPromise = null;
      appState.contextFallbackPromise = null;
    }

    if (getSetting('silenceDetection')) {
      scheduleSilenceDetection();
    }
  } catch (err) {
    const message = toUserFacingError(err);
    logger.error('echo', `Recording start failed: ${message}`);
    appState.setState(EchoState.Error, message);
    // Same auto-recovery the pipeline error path uses — otherwise the overlay
    // and tray stay pinned on the error until the next manual trigger.
    setTimeout(() => {
      if (appState.state === EchoState.Error) {
        appState.setState(EchoState.Idle);
      }
    }, 3000);
  }
}

async function stopRecording(): Promise<void> {
  if (stopInProgress) return;
  stopInProgress = true;
  try {
    cancelPendingStart();
    clearFnStrayTapTimer();
    stopSilenceDetection();
    stopHoldDetection();
    fnSessionMode = 'idle';
    hotkeyHoldRecording = false;
    playRecordingStop();
    liveTranscriber.stop();
    // Leave Recording synchronously so a second stop trigger can't start a
    // second pipeline while we drain the live-injection queue below.
    if (appState.state === EchoState.Recording) {
      appState.setState(EchoState.Transcribing);
    }
    // Wait for any in-flight live paste so the pipeline's injected-char count
    // matches what is actually on screen.
    try { await liveInjectQueue; } catch { /* injection is best-effort */ }
    await runPipeline(appState, recorder, whisper, macosSTT, inserter, memory, liveInjectedText);
  } finally {
    stopInProgress = false;
  }
}

/** Discard the current recording without running the pipeline (stray tap / cancel). */
function cancelRecording(): void {
  cancelPendingStart();
  clearFnStrayTapTimer();
  stopSilenceDetection();
  stopHoldDetection();
  fnSessionMode = 'idle';
  hotkeyHoldRecording = false;
  if (appState.state === EchoState.Recording) {
    recorder.forceStop();
    liveTranscriber.forceStop();
    liveInjectedText = '';
    // Live chunks may have replaced the user's clipboard mid-recording.
    void inserter.restoreUserClipboard();
    appState.setState(EchoState.Idle);
  }
}

// --- App Lifecycle ---
app.dock?.hide();

// Renderers only ever load bundled files. Block navigation anywhere else and
// route attempted new windows to the default browser instead of a BrowserWindow
// (which would carry the privileged preload bridge).
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.whenReady().then(() => {
  // Packaged builds have a stable app identity, so the Swift helpers should skip
  // their "disclaim responsibility" trick and let TCC key Input Monitoring /
  // Accessibility on "Echo" itself (one row, matching onboarding) instead of
  // separate `fn-monitor` / `text-insert` rows. Helpers inherit this env. Dev
  // leaves it unset so disclaim still shields grants from parent cdhash churn.
  // (Mirror of the ECHO_NO_DISCLAIM gate in src-tauri/src/lib.rs.)
  if (app.isPackaged) process.env.ECHO_NO_DISCLAIM = '1';

  createTray(appState, toggle, openSettings);
  createOverlay();

  // IPC first — a failure anywhere below (e.g. a malformed user-typed hotkey)
  // must not leave every window's `echo` API dead.
  setupIPC(appState, whisper, memory, toggle, inserter, recorder, liveTranscriber,
    () => ({ ok: fnKeyMonitor.inputMonitoring === 'granted', status: fnKeyMonitor.inputMonitoring }),
    cancelRecording);

  // Update tray + overlay on state changes
  appState.on('stateChange', (state: EchoState, previous: EchoState) => {
    if (state === EchoState.Error) playError();
    updateTray(appState, toggle, openSettings);
    // Only a successful insertion (Inserting → Idle) flashes the green "Done"
    // with the result — errors, cancels, and empty transcriptions go quiet.
    const succeeded = state === EchoState.Idle && previous === EchoState.Inserting;
    sendOverlayState(appState.state, {
      lastResult: succeeded ? (appState.lastRefinedText?.substring(0, 60) ?? undefined) : undefined,
      rawResult: succeeded ? (appState.lastTranscription ?? undefined) : undefined,
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
  liveTranscriber.on('final', (text: string) => {
    sendLiveTranscript(text);
    const newText = text.trim();
    if (!newText) return;
    liveInjectQueue = liveInjectQueue
      .then(async () => {
        if (appState.state !== EchoState.Recording) return;
        // First chunk continues the caret context — the same join the pipeline
        // applies to the final replacement; later chunks join with a space.
        const adjusted = liveInjectedText
          ? ' ' + newText
          : (appState.existingFieldText ? joinContinuation(appState.existingFieldText, newText) : newText);
        // Only count text that actually landed — a phantom count would make
        // the final replace delete the user's own text.
        if (await inserter.insertLive(adjusted)) {
          liveInjectedText += adjusted;
          console.log(`[echo] Live injected: "${newText}" (total: ${liveInjectedText.length} chars)`);
        }
      })
      .catch(() => { /* injection is best-effort */ });
  });

  // Forward audio levels to overlay for waveform visualization
  recorder.on('level', (level: number) => sendAudioLevel(level));

  // Start fn key monitor (primary hotkey)
  fnKeyMonitor.on('action', handleFnAction);
  fnKeyMonitor.on('dead', (info: { inputMonitoring?: string }) => {
    // The monitor exhausted its restart budget — the primary hotkey is gone
    // until it recovers, so say so instead of failing silently.
    const body = info?.inputMonitoring === 'denied'
      ? 'fn hotkey stopped — grant Input Monitoring in System Settings > Privacy & Security, then restart Echo.'
      : `fn hotkey stopped working — use ${getSetting('hotkey')} or restart Echo.`;
    new Notification({ title: 'Echo', body }).show();
  });

  // Compile Swift helpers off the main thread (the old execFileSync compiles
  // froze the app for seconds at startup). fn-monitor first so the primary
  // hotkey comes up ASAP, then the rest sequentially — no swiftc CPU spike.
  void (async () => {
    await ensureSwiftBinaryAsync('fn-monitor', 'scripts/fn-monitor.swift');
    fnKeyMonitor.start();
    console.log('[echo] fn key monitor started');
    await ensureSwiftBinaryAsync('record', 'scripts/record.swift');
    await ensureSwiftBinaryAsync('live-transcribe', 'scripts/live-transcribe.swift');
    await ensureSwiftBinaryAsync('transcribe', 'scripts/transcribe.swift');
    await ensureSwiftBinaryAsync('field-context', 'scripts/field-context.swift');
    await ensureSwiftBinaryAsync('text-insert', 'scripts/text-insert.swift');
    // Insertion posts keystrokes from the disclaimed `text-insert` helper (its
    // own stable TCC identity), so it needs its own Accessibility grant. Prompt
    // once so it appears in System Settings for the user to enable.
    if (TextInserter.ensureAccessibility()) {
      console.log('[echo] text-insert Accessibility already granted');
    } else {
      logger.warn('echo', 'text-insert needs Accessibility — prompted; enable it in System Settings');
    }

    // Check dependencies once the helpers exist (the native recorder is the
    // hard requirement — this also compiles it if the async pass failed).
    const recorderCheck = AudioRecorder.checkDependencies();
    if (!recorderCheck.ok) logger.warn('echo', recorderCheck.message ?? 'audio recorder not ready');
  })();

  // Register fallback global hotkeys. register() throws on malformed
  // accelerators (the settings field is free text) — a bad one must not
  // abort the rest of startup.
  const safeRegister = (accel: string, cb: () => void, label: string): void => {
    try {
      if (globalShortcut.register(accel, cb)) {
        console.log(`[echo] ${label} hotkey registered: ${accel}`);
      } else {
        console.error(`[echo] Failed to register ${label} hotkey: ${accel}`);
      }
    } catch (err) {
      console.error(`[echo] Invalid ${label} hotkey "${accel}": ${(err as Error).message}`);
    }
  };
  const hotkey = getSetting('hotkey');
  safeRegister(hotkey, toggle, 'toggle');
  safeRegister(getSetting('overlayHotkey'), toggleOverlay, 'overlay');
  safeRegister(getSetting('undoHotkey'), () => { void undoLastInsertion(appState, inserter); }, 'undo');

  // Auto-update (packaged builds only)
  setupAutoUpdater();

  const whisperCheck = whisper.isReady();
  if (!whisperCheck.binary || !whisperCheck.model) {
    logger.warn('echo', 'Whisper not ready. Run: npm run setup');
  }

  const axCheck = TextInserter.checkPermissions();
  if (!axCheck.ok) logger.warn('echo', axCheck.message ?? 'Accessibility not granted');

  // In dev, process.execPath is the bare Electron shell — registering it as a
  // login item would open an empty Electron window at login instead of Echo.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: getSetting('openAtLogin') });
  }

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
  whisper.shutdown();
  memory.flush();
  getEditLearner().flush();
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

// A crash mid-recording must tear the recording down — otherwise the mic
// stays hot and every future start throws "Already recording".
function handleFatalError(err: unknown): void {
  if (appState.isRecording) {
    recorder.forceStop();
    liveTranscriber.forceStop();
    stopSilenceDetection();
    stopHoldDetection();
    cancelPendingStart();
    fnSessionMode = 'idle';
    hotkeyHoldRecording = false;
  }
  appState.setState(EchoState.Error, toUserFacingError(err));
  setTimeout(() => {
    if (appState.state === EchoState.Error) appState.setState(EchoState.Idle);
  }, 3000);
}

process.on('uncaughtException', (err) => {
  console.error('[echo] Uncaught exception:', err);
  if (!isShuttingDown) handleFatalError(err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[echo] Unhandled rejection:', reason);
  if (!isShuttingDown) handleFatalError(reason);
});
