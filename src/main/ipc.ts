import { app, dialog, globalShortcut, ipcMain, clipboard, systemPreferences } from 'electron';
import { execFileSync, execSync } from 'child_process';
import { AppState, EchoState } from './appState';
import { LiveTranscriber } from './transcription/liveTranscriber';
import { AudioRecorder } from './audio/recorder';
import { GroqTranscriber } from './transcription/groqTranscriber';
import { DeepgramTranscriber } from './transcription/deepgramTranscriber';
import { OpenAIWhisperTranscriber } from './transcription/openaiWhisperTranscriber';
import { WhisperService, WHISPER_MODELS } from './transcription/whisperService';
import { TextInserter } from './insertion/textInserter';
import { undoLastInsertion } from './insertion/undo';
import { MemoryStore } from './memory/memoryStore';
import { MemoryEntry } from './memory/memoryEntry';
import { CodebaseAnalyzer } from './codebase/analyzer';
import { getAllSettings, setSetting, getSetting } from './settings/settings';
import { DEFAULT_PROMPT_VERSION } from './refinement/refiner';
import { computeStats } from './history/stats';
import { checkAllProviders } from './providers/providerHealth';
import { logger } from './utils/logger';
import { templateStore, getRunLog } from './pipeline';
import { resizeOverlay, toggleOverlay } from './overlay';
import { openSettings, getSettingsWindow, getOnboardingWindow, closeOnboarding } from './windows';

export function setupIPC(
  appState: AppState,
  whisper: WhisperService,
  memory: MemoryStore,
  toggle: () => void,
  inserter?: TextInserter,
  recorder?: AudioRecorder,
  liveTranscriber?: LiveTranscriber,
  inputMonitoringStatus?: () => { ok: boolean; status: string },
  cancel?: () => void,
): void {
  ipcMain.handle('get-settings', () => getAllSettings());

  // Hotkey changes take effect immediately: re-register the accelerator and
  // report failure to the renderer so the UI never claims a dead hotkey.
  const hotkeyAction = (key: 'hotkey' | 'overlayHotkey' | 'undoHotkey'): (() => void) => {
    if (key === 'hotkey') return toggle;
    if (key === 'overlayHotkey') return () => toggleOverlay();
    return () => {
      if (inserter) void undoLastInsertion(appState, inserter);
    };
  };
  const applyHotkeySetting = (key: 'hotkey' | 'overlayHotkey' | 'undoHotkey', accel: string): { ok: boolean; error?: string } => {
    const old = getSetting(key);
    if (accel === old) return { ok: true };
    const action = hotkeyAction(key);
    try { globalShortcut.unregister(old); } catch { /* was never registered */ }
    let ok = false;
    let error: string | undefined;
    try {
      // register() throws on malformed accelerators (the field is free text)
      // and returns false when another app holds the shortcut.
      ok = globalShortcut.register(accel, action);
      if (!ok) error = 'Hotkey is already in use by another app';
    } catch (err) {
      error = (err as Error).message;
    }
    if (!ok) {
      try { globalShortcut.register(old, action); } catch { /* old accel also unusable */ }
      return { ok: false, error };
    }
    setSetting(key, accel);
    return { ok: true };
  };

  ipcMain.handle('set-setting', (_e, key: string, value: unknown) => {
    if (key === 'hotkey' || key === 'overlayHotkey' || key === 'undoHotkey') {
      return applyHotkeySetting(key, String(value));
    }
    setSetting(key as keyof ReturnType<typeof getAllSettings>, value as never);
    if (key === 'openAtLogin' && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: value as boolean });
    }
    return { ok: true };
  });

  ipcMain.handle('get-memory', () => memory.getAll());
  ipcMain.handle('add-memory', (_e, entry: { term: string; context: string; misrecognitions: string[]; category: string }) => {
    return memory.add({
      term: entry.term,
      context: entry.context,
      misrecognitions: entry.misrecognitions,
      category: entry.category as MemoryEntry['category'],
    });
  });
  ipcMain.handle('remove-memory', (_e, id: string) => memory.remove(id));

  ipcMain.handle('get-status', () => ({
    state: appState.state,
    whisper: whisper.isReady(),
    sox: AudioRecorder.checkDependencies(),
    accessibility: TextInserter.checkPermissions(),
    microphone: getMicrophoneStatus(),
    inputMonitoring: inputMonitoringStatus ? inputMonitoringStatus() : { ok: false, status: 'unknown' },
    // Optional/situational permissions. Screen Recording is queryable via TCC;
    // Speech Recognition and Automation (Apple Events) have no supported query
    // API, so they report "unknown" and the UI offers an "Open" shortcut.
    screenRecording: getScreenRecordingStatus(),
    speechRecognition: { ok: false, status: 'unknown' },
    automation: { ok: false, status: 'unknown' },
  }));

  // Overlay actions
  ipcMain.handle('toggle', () => toggle());
  // Route through the same teardown as the fn-key cancel path (silence
  // listeners, timers, session flags) — a bare forceStop leaks all of those.
  ipcMain.handle('cancel-recording', () => {
    if (cancel) {
      cancel();
      return;
    }
    if (appState.state === EchoState.Recording) {
      recorder?.forceStop();
      liveTranscriber?.forceStop();
      appState.setState(EchoState.Idle);
    }
  });
  ipcMain.handle('toggle-overlay', () => toggleOverlay());
  ipcMain.handle('open-settings', () => openSettings());
  ipcMain.handle('resize-overlay', (_e, expanded: boolean) => resizeOverlay(expanded));

  // Re-insert text (raw vs polished toggle)
  ipcMain.handle('reinsert-text', async (_e, text: string) => {
    if (inserter && text) {
      await inserter.insert(text, appState.sourceApp);
    }
  });


  // Codebase analysis
  ipcMain.handle('scan-project', async (_e, projectPath: string, projectName: string) => {
    try {
      const analyzer = new CodebaseAnalyzer();
      const context = await analyzer.analyze(projectPath, projectName, (streamedText) => {
        // Onboarding hosts the same scan UI — stream to both windows.
        for (const win of [getOnboardingWindow(), getSettingsWindow()]) {
          if (win && !win.isDestroyed()) {
            win.webContents.send('scan-stream', streamedText);
          }
        }
      });
      return { success: true, length: context.length };
    } catch (err) {
      console.error('[scan-project] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Onboarding
  ipcMain.handle('open-accessibility-settings', () => {
    execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"');
  });
  ipcMain.handle('open-input-monitoring-settings', () => {
    try {
      execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"');
    } catch {
      try { execSync('open "x-apple.systempreferences:com.apple.preference.security"'); } catch { /* settings unavailable */ }
    }
  });
  // Microphone: if access was never requested, trigger the native prompt; otherwise
  // (denied/restricted) jump to the Microphone pane in System Settings.
  ipcMain.handle('open-microphone-settings', async () => {
    let status: string;
    try {
      status = systemPreferences.getMediaAccessStatus('microphone');
    } catch {
      status = 'unknown';
    }
    if (status === 'not-determined') {
      try {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        return { granted, prompted: true };
      } catch { /* fall through to opening System Settings */ }
    }
    try {
      execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"');
    } catch { /* settings unavailable */ }
    return { granted: status === 'granted', prompted: false };
  });
  // Situational permission panes. These have no native "prompt" API (unlike the
  // microphone), so they just deep-link to the correct System Settings pane.
  ipcMain.handle('open-screen-recording-settings', () => {
    try {
      execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"');
    } catch { /* settings unavailable */ }
  });
  ipcMain.handle('open-speech-recognition-settings', () => {
    try {
      execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition"');
    } catch { /* settings unavailable */ }
  });
  ipcMain.handle('open-automation-settings', () => {
    try {
      execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"');
    } catch { /* settings unavailable */ }
  });
  ipcMain.handle('complete-onboarding', () => closeOnboarding());

  // Whisper model download with progress
  ipcMain.handle('download-whisper-model', async (_e, modelName?: string) => {
    try {
      const name = modelName || getSetting('whisperModelName');
      await whisper.downloadModel((percent: number) => {
        // Send progress to both onboarding and settings windows
        const onbWin = getOnboardingWindow();
        if (onbWin && !onbWin.isDestroyed()) {
          onbWin.webContents.send('download-progress', percent);
        }
        const setWin = getSettingsWindow();
        if (setWin && !setWin.isDestroyed()) {
          setWin.webContents.send('download-progress', percent);
        }
      }, name);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Check if whisper binary and current model exist
  ipcMain.handle('check-whisper-binary', (_e, modelName?: string) => {
    const name = modelName || getSetting('whisperModelName');
    const status = whisper.isReady(name);
    return { binary: status.binary, model: status.model };
  });

  // List available whisper models + which are downloaded
  ipcMain.handle('list-whisper-models', () => {
    const downloaded = whisper.listDownloadedModels();
    return WHISPER_MODELS.map(m => ({
      ...m,
      downloaded: downloaded.includes(m.name),
    }));
  });

  // Build whisper.cpp binary from source
  ipcMain.handle('build-whisper-binary', async () => {
    try {
      await whisper.buildBinary((message: string) => {
        for (const win of [getOnboardingWindow(), getSettingsWindow()]) {
          if (win && !win.isDestroyed()) {
            win.webContents.send('build-progress', message);
          }
        }
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Check if a CLI tool exists on PATH. The name crosses the IPC boundary,
  // so it must stay a bare tool name and never reach a shell.
  ipcMain.handle('check-cli-exists', (_e, command: string) => {
    if (typeof command !== 'string' || !/^[A-Za-z0-9._-]+$/.test(command)) return false;
    try {
      execFileSync('which', [command], { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('browse-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Project Folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('list-audio-devices', () => AudioRecorder.listInputDevices());

  ipcMain.handle('check-prompt-staleness', () => {
    const customPrompt = getSetting('customPrompt');
    const customDate = getSetting('customPromptDate');
    if (!customPrompt) return { stale: false };
    if (!customDate) return { stale: true, defaultVersion: DEFAULT_PROMPT_VERSION };
    return {
      stale: customDate < DEFAULT_PROMPT_VERSION,
      defaultVersion: DEFAULT_PROMPT_VERSION,
      customDate,
    };
  });

  // Run log — the pipeline's singleton, so History/stats see new dictations
  // immediately and clearing the log isn't undone by the next run's stale copy.
  const runLog = getRunLog();
  ipcMain.handle('get-run-log', () => runLog.getAll());
  ipcMain.handle('clear-run-log', () => runLog.clear());
  ipcMain.handle('get-stats', () => computeStats(runLog));

  ipcMain.handle('validate-groq-key', async (_e, apiKey: string) => {
    return GroqTranscriber.validateApiKey(apiKey);
  });

  ipcMain.handle('validate-deepgram-key', async (_e, apiKey: string) => {
    return DeepgramTranscriber.validateApiKey(apiKey);
  });

  ipcMain.handle('validate-openai-key', async (_e, apiKey: string) => {
    return OpenAIWhisperTranscriber.validateApiKey(apiKey);
  });

  ipcMain.handle('check-providers', async () => {
    return checkAllProviders(whisper);
  });

  ipcMain.handle('get-logs', () => logger.readRecentLogs());
  ipcMain.handle('copy-logs', () => {
    const logs = logger.readRecentLogs();
    clipboard.writeText(logs);
    return { success: true, length: logs.length };
  });

  // Templates
  ipcMain.handle('get-templates', () => templateStore.getAll());
  ipcMain.handle('add-template', (_e, template: { name: string; trigger: string; content: string }) => {
    return templateStore.add(template);
  });
  ipcMain.handle('remove-template', (_e, id: string) => templateStore.remove(id));

  // History search
  ipcMain.handle('search-run-log', (_e, query: string) => runLog.search(query));
  ipcMain.handle('reinsert-from-history', async (_e, text: string) => {
    if (inserter && text) {
      await inserter.insert(text, appState.sourceApp);
    }
  });

  ipcMain.handle('undo-last-insertion', async () => {
    if (inserter) {
      await undoLastInsertion(appState, inserter);
    }
  });

  ipcMain.handle('get-project-context', () => {
    return {
      hasContext: CodebaseAnalyzer.hasContext(),
      context: CodebaseAnalyzer.loadContext(),
      path: CodebaseAnalyzer.getContextPath(),
    };
  });
}

/**
 * Current microphone (TCC) authorization status.
 * Maps Electron's getMediaAccessStatus → { ok, status } where status is one of
 * 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'.
 */
function getMicrophoneStatus(): { ok: boolean; status: string } {
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    return { ok: status === 'granted', status };
  } catch {
    return { ok: false, status: 'unknown' };
  }
}

/**
 * Current Screen Recording (TCC) authorization status. Only needed when the
 * "Capture screenshots" context option is enabled. Same shape as microphone.
 */
function getScreenRecordingStatus(): { ok: boolean; status: string } {
  try {
    const status = systemPreferences.getMediaAccessStatus('screen');
    return { ok: status === 'granted', status };
  } catch {
    return { ok: false, status: 'unknown' };
  }
}
