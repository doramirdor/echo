// Tauri bridge: maps window.echo API (Electron IPC) to Tauri invoke/events.
// This file is loaded before settings.js and provides the same interface.

(function() {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

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

    // Re-insert text
    reinsertText: (text) => invoke('reinsert_text', { text }),

    // Onboarding
    openAccessibilitySettings: () => invoke('open_accessibility_settings'),
    openInputMonitoringSettings: () => invoke('open_input_monitoring_settings'),
    openMicrophoneSettings: () => invoke('open_microphone_settings'),
    completeOnboarding: () => invoke('complete_onboarding'),
    downloadWhisperModel: (modelName) => invoke('download_whisper_model', { modelName: modelName || null }),
    buildWhisperBinary: () => invoke('build_whisper_binary'),
    checkWhisperBinary: (modelName) => invoke('check_whisper_binary', { modelName: modelName || null }),
    listWhisperModels: () => invoke('list_whisper_models'),
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

    // Overlay click-through (handled differently in Tauri - using window API)
    overlayMouseEnter: () => {
      const win = window.__TAURI__.window?.getCurrentWindow?.();
      if (win) win.setIgnoreCursorEvents(false).catch(() => {});
    },
    overlayMouseLeave: () => {
      const win = window.__TAURI__.window?.getCurrentWindow?.();
      if (win) win.setIgnoreCursorEvents(true).catch(() => {});
    },

    // Overlay drag (using Tauri's built-in drag)
    overlayDragStart: () => {
      const win = window.__TAURI__.window?.getCurrentWindow?.();
      if (win) win.startDragging().catch(() => {});
    },
    overlayDragMove: () => {},
  };
})();
