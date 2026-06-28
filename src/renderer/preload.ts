import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('echo', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke('set-setting', key, value),

  // Memory
  getMemory: () => ipcRenderer.invoke('get-memory'),
  addMemory: (entry: { term: string; context: string; misrecognitions: string[]; category: string }) =>
    ipcRenderer.invoke('add-memory', entry),
  removeMemory: (id: string) => ipcRenderer.invoke('remove-memory', id),

  // Status
  getStatus: () => ipcRenderer.invoke('get-status'),

  // Overlay actions
  toggle: () => ipcRenderer.invoke('toggle'),
  cancelRecording: () => ipcRenderer.invoke('cancel-recording'),
  toggleOverlay: () => ipcRenderer.invoke('toggle-overlay'),
  openSettings: () => ipcRenderer.invoke('open-settings'),

  // State change listener (overlay uses this for real-time updates)
  onStateChange: (callback: (state: string, data: { lastResult?: string; error?: string }) => void) => {
    ipcRenderer.on('state-change', (_e, state, data) => callback(state, data));
  },

  // Live transcription
  onLiveTranscript: (callback: (text: string) => void) => {
    ipcRenderer.on('live-transcript', (_e, text) => callback(text));
  },

  // Audio level metering (0–1 normalized)
  onAudioLevel: (callback: (level: number) => void) => {
    ipcRenderer.on('audio-level', (_e, level) => callback(level));
  },

  // Overlay resize
  resizeOverlay: (expanded: boolean) => ipcRenderer.invoke('resize-overlay', expanded),

  // Codebase scanning
  scanProject: (projectPath: string, projectName: string) => ipcRenderer.invoke('scan-project', projectPath, projectName),
  getProjectContext: () => ipcRenderer.invoke('get-project-context'),
  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  onScanStream: (callback: (text: string) => void) => {
    ipcRenderer.on('scan-stream', (_e, text) => callback(text));
  },

  // Audio devices
  listAudioDevices: () => ipcRenderer.invoke('list-audio-devices'),

  // Prompt staleness
  checkPromptStaleness: () => ipcRenderer.invoke('check-prompt-staleness'),

  // Run log
  getRunLog: () => ipcRenderer.invoke('get-run-log'),
  clearRunLog: () => ipcRenderer.invoke('clear-run-log'),
  getStats: () => ipcRenderer.invoke('get-stats'),

  // API validation
  validateGroqKey: (apiKey: string) => ipcRenderer.invoke('validate-groq-key', apiKey),
  validateDeepgramKey: (apiKey: string) => ipcRenderer.invoke('validate-deepgram-key', apiKey),
  validateOpenaiKey: (apiKey: string) => ipcRenderer.invoke('validate-openai-key', apiKey),
  checkProviders: () => ipcRenderer.invoke('check-providers'),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  copyLogs: () => ipcRenderer.invoke('copy-logs'),

  // Templates
  getTemplates: () => ipcRenderer.invoke('get-templates'),
  addTemplate: (template: { name: string; trigger: string; content: string }) =>
    ipcRenderer.invoke('add-template', template),
  removeTemplate: (id: string) => ipcRenderer.invoke('remove-template', id),

  // History search
  searchRunLog: (query: string) => ipcRenderer.invoke('search-run-log', query),
  reinsertFromHistory: (text: string) => ipcRenderer.invoke('reinsert-from-history', text),

  // Re-insert text (for raw vs polished toggle)
  reinsertText: (text: string) => ipcRenderer.invoke('reinsert-text', text),


  // Onboarding
  openAccessibilitySettings: () => ipcRenderer.invoke('open-accessibility-settings'),
  openInputMonitoringSettings: () => ipcRenderer.invoke('open-input-monitoring-settings'),
  openMicrophoneSettings: () => ipcRenderer.invoke('open-microphone-settings'),
  completeOnboarding: () => ipcRenderer.invoke('complete-onboarding'),
  downloadWhisperModel: (modelName?: string) => ipcRenderer.invoke('download-whisper-model', modelName),
  buildWhisperBinary: () => ipcRenderer.invoke('build-whisper-binary'),
  checkWhisperBinary: (modelName?: string) => ipcRenderer.invoke('check-whisper-binary', modelName),
  listWhisperModels: () => ipcRenderer.invoke('list-whisper-models'),
  checkCliExists: (command: string) => ipcRenderer.invoke('check-cli-exists', command),
  onDownloadProgress: (callback: (percent: number) => void) => {
    ipcRenderer.on('download-progress', (_e, percent) => callback(percent));
  },
  onBuildProgress: (callback: (message: string) => void) => {
    ipcRenderer.on('build-progress', (_e, message) => callback(message));
  },

  onConfidenceSegments: (callback: (segments: Array<{ text: string; confidence: number }>) => void) => {
    ipcRenderer.on('confidence-segments', (_e, segments) => callback(segments));
  },

  onProgress: (callback: (state: string, data: { wordCount?: number; eta?: number }) => void) => {
    ipcRenderer.on('progress', (_e, state, data) => callback(state, data));
  },

  // Overlay click-through
  overlayMouseEnter: () => ipcRenderer.send('overlay-mouse-enter'),
  overlayMouseLeave: () => ipcRenderer.send('overlay-mouse-leave'),

  // Overlay drag
  overlayDragStart: () => ipcRenderer.send('overlay-drag-start'),
  overlayDragMove: (deltaX: number, deltaY: number) => ipcRenderer.send('overlay-drag-move', deltaX, deltaY),
});
