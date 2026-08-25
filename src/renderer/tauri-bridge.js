// Tauri bridge: maps window.echo API (Electron IPC) to Tauri invoke/events.
// This file is loaded before settings.js and provides the same interface.

(function() {
  // Under Electron this file is still loaded but the preload bridge provides
  // window.echo — bail out instead of throwing on every window.
  if (!window.__TAURI__) return;
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  // Logical (CSS-px) position of the overlay window captured at drag start.
  let dragStartLogical = null;

  window.echo = {
    // Settings
    getSettings: () => invoke('get_settings'),
    setSetting: (key, value) => invoke('set_setting', { key, value }),

    // Memory
    getMemory: () => invoke('get_memory'),
    addMemory: (entry) => invoke('add_memory', entry),
    removeMemory: (id) => invoke('remove_memory', { id }),

    // Status
    getStatus: () => invoke('get_status'),

    // Overlay actions
    toggle: () => invoke('toggle'),
    cancelRecording: () => invoke('cancel_recording'),
    toggleOverlay: () => invoke('toggle_overlay_cmd'),
    openSettings: () => invoke('open_settings_window'),

    // State change listener
    onStateChange: (callback) => {
      listen('state-change', (event) => {
        const [state, data] = Array.isArray(event.payload) ? event.payload : [event.payload, {}];
        callback(state, data || {});
      });
    },

    // Live transcription
    onLiveTranscript: (callback) => {
      listen('live-transcript', (event) => callback(event.payload));
    },

    // Audio level metering
    onAudioLevel: (callback) => {
      listen('audio-level', (event) => callback(event.payload));
    },

    // Overlay resize
    resizeOverlay: (expanded) => invoke('resize_overlay', { expanded }).catch(() => {}),

    // Codebase scanning
    scanProject: (projectPath, projectName) => invoke('scan_project', { projectPath, projectName }),
    getProjectContext: () => invoke('get_project_context'),
    browseFolder: async () => {
      try {
        const result = await window.__TAURI__.dialog.open({ directory: true, title: 'Select Project Folder' });
        return result || null;
      } catch { return null; }
    },
    onScanStream: (callback) => {
      listen('scan-stream', (event) => callback(event.payload));
    },

    // Audio devices
    listAudioDevices: () => invoke('list_audio_devices'),

    // Prompt staleness
    checkPromptStaleness: () => invoke('check_prompt_staleness'),

    // Run log
    getRunLog: () => invoke('get_run_log'),
    clearRunLog: () => invoke('clear_run_log'),
    getStats: () => invoke('get_stats'),

    // API validation
    validateGroqKey: (apiKey) => invoke('validate_groq_key', { apiKey }),
    validateDeepgramKey: (apiKey) => invoke('validate_deepgram_key', { apiKey }),
    validateOpenaiKey: (apiKey) => invoke('validate_openai_key', { apiKey }),
    checkProviders: () => invoke('check_providers'),
    getLogs: () => invoke('get_logs'),
    copyLogs: () => invoke('copy_logs'),

    // Templates
    getTemplates: () => invoke('get_templates'),
    addTemplate: (template) => invoke('add_template', template),
    removeTemplate: (id) => invoke('remove_template', { id }),

    // History search
    searchRunLog: (query) => invoke('search_run_log', { query }),
    reinsertFromHistory: (text) => invoke('reinsert_from_history', { text }),
    undoLastInsertion: () => invoke('undo_last_insertion'),

    // Re-insert text
    reinsertText: (text) => invoke('reinsert_text', { text }),

    // Onboarding
    openAccessibilitySettings: () => invoke('open_accessibility_settings'),
    openInputMonitoringSettings: () => invoke('open_input_monitoring_settings'),
    freeFnKey: () => invoke('free_fn_key'),
    openMicrophoneSettings: () => invoke('open_microphone_settings'),
    openScreenRecordingSettings: () => invoke('open_screen_recording_settings'),
    openSpeechRecognitionSettings: () => invoke('open_speech_recognition_settings'),
    openAutomationSettings: () => invoke('open_automation_settings'),
    completeOnboarding: () => invoke('complete_onboarding'),
    downloadWhisperModel: (modelName) => invoke('download_whisper_model', { modelName: modelName || null }),
    buildWhisperBinary: () => invoke('build_whisper_binary'),
    checkWhisperBinary: (modelName) => invoke('check_whisper_binary', { modelName: modelName || null }),
    listWhisperModels: () => invoke('list_whisper_models'),
    downloadParakeetModel: (modelName) => invoke('download_parakeet_model', { modelName: modelName || null }),
    buildParakeetBinary: () => invoke('build_parakeet_binary'),
    checkParakeetBinary: (modelName) => invoke('check_parakeet_binary', { modelName: modelName || null }),
    listParakeetModels: () => invoke('list_parakeet_models'),
    checkCliExists: (command) => invoke('check_cli_exists', { command }),
    onDownloadProgress: (callback) => {
      listen('download-progress', (event) => callback(event.payload));
    },
    onBuildProgress: (callback) => {
      listen('build-progress', (event) => callback(event.payload));
    },

    onConfidenceSegments: (callback) => {
      listen('confidence-segments', (event) => callback(event.payload));
    },

    onProgress: (callback) => {
      listen('progress', (event) => {
        const [state, data] = Array.isArray(event.payload) ? event.payload : [event.payload, {}];
        callback(state, data || {});
      });
    },

    // Overlay hover: the window stays interactive at all times. wry has no
    // Electron-style `forward` option, so we can't make the transparent margin
    // click-through and still detect hover. Instead the idle window hugs the
    // collapsed pill (so it blocks almost nothing) and grows to fit the revealed
    // "Dictate fn" label only while hovered. The resize is driven from the Rust
    // side, which also ignores hovers outside the idle state.
    overlayMouseEnter: () => invoke('overlay_mouse_enter').catch(() => {}),
    overlayMouseLeave: () => invoke('overlay_mouse_leave').catch(() => {}),

    // Overlay drag: mirror the Electron delta approach (record the window's
    // position on mousedown, then set an absolute position from screen-space
    // deltas). Tauri's native startDragging() needs core:window:allow-start-
    // dragging AND fires reliably only from the synchronous mousedown NSEvent —
    // the async JS→IPC hop drops it — so instead we move the window ourselves
    // via set-position, which is already granted in capabilities.
    overlayDragStart: () => {
      const win = window.__TAURI__.window?.getCurrentWindow?.();
      if (!win) return;
      dragStartLogical = null;
      Promise.all([win.outerPosition(), win.scaleFactor()])
        .then(([pos, scale]) => { dragStartLogical = { x: pos.x / scale, y: pos.y / scale }; })
        .catch(() => {});
    },
    overlayDragMove: (deltaX, deltaY) => {
      const win = window.__TAURI__.window?.getCurrentWindow?.();
      if (!win || !dragStartLogical) return;
      // setPosition only inspects `.type`/`.x`/`.y`, so a plain Logical object
      // avoids depending on where the dpi classes are namespaced in the global.
      win.setPosition({ type: 'Logical', x: dragStartLogical.x + deltaX, y: dragStartLogical.y + deltaY }).catch(() => {});
    },
  };
})();
