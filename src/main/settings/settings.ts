import Store from 'electron-store';

export type LLMProvider = 'claude-cli' | 'codex-cli' | 'claude-api' | 'openai-api' | 'gemini' | 'bedrock' | 'groq' | 'ollama' | 'llama-local' | 'none';
export type STTEngine = 'groq' | 'macos' | 'whisper' | 'deepgram' | 'openai-whisper';

export type ContextProvider = 'claude' | 'groq' | 'none';
export type RecordingMode = 'toggle' | 'hold';
export type Tone = 'casual' | 'formal';

export interface EchoSettings {
  hotkey: string;
  overlayHotkey: string;
  sttEngine: STTEngine;
  groqApiKey: string;
  deepgramApiKey: string;
  openaiApiKey: string;
  openaiWhisperModel: string;
  llmProvider: LLMProvider;
  claudeApiKey: string;
  claudeApiModel: string;
  openaiApiModel: string;
  geminiApiKey: string;
  geminiModel: string;
  bedrockAccessKeyId: string;
  bedrockSecretAccessKey: string;
  bedrockRegion: string;
  bedrockModel: string;
  groqLlmModel: string;
  ollamaEndpoint: string;
  ollamaModel: string;
  llamaEndpoint: string;
  llamaModel: string;
  whisperModelName: string;
  openAtLogin: boolean;
  onboardingComplete: boolean;
  customPrompt: string;
  vocabularyList: string;
  useWindowContext: boolean;
  contextProvider: ContextProvider;
  recordingMode: RecordingMode;
  startDelay: number;
  audioDevice: string;
  customPromptDate: string;
  grammarCheck: boolean;
  autoFormatContent: boolean;  // auto-format dictated lists/emails/long passages
  silenceDetection: boolean;
  silenceThreshold: number;  // 0–1 level below which counts as silence
  silenceDuration: number;   // ms of silence before auto-stopping
  captureScreenshots: boolean;  // capture screenshots for context
  autoHideOverlay: boolean;     // hide overlay when idle, auto-show on recording
  transcriptionLanguage: string; // ISO language code for STT (e.g. 'en', 'auto')
  appProfiles: Record<string, string>; // per-app refinement profile overrides
  voiceCommandsEnabled: boolean;
  dictationHistoryContext: number; // number of recent dictations to include in context
  tone: Tone;
  noiseReduction: boolean;
  whisperMode: boolean;       // boost gain + compressor for whispered speech
  crashReportingEnabled: boolean;
  autoUpdateEnabled: boolean;
}

const defaults: EchoSettings = {
  hotkey: 'CommandOrControl+Shift+V',
  overlayHotkey: 'CommandOrControl+Shift+B',
  sttEngine: 'whisper',
  groqApiKey: '',
  deepgramApiKey: '',
  openaiApiKey: '',
  openaiWhisperModel: 'whisper-1',
  llmProvider: 'claude-cli',
  claudeApiKey: '',
  claudeApiModel: 'claude-sonnet-4-20250514',
  openaiApiModel: 'gpt-4o-mini',
  geminiApiKey: '',
  geminiModel: 'gemini-2.0-flash',
  bedrockAccessKeyId: '',
  bedrockSecretAccessKey: '',
  bedrockRegion: 'us-east-1',
  bedrockModel: 'anthropic.claude-3-5-haiku-20241022-v1:0',
  groqLlmModel: 'llama-3.1-8b-instant',
  ollamaEndpoint: 'http://localhost:11434',
  ollamaModel: 'llama3.2',
  llamaEndpoint: 'http://localhost:8080',
  llamaModel: 'llama-3.2-3b',
  whisperModelName: 'ggml-base.en.bin',
  openAtLogin: false,
  onboardingComplete: false,
  customPrompt: '',
  vocabularyList: '',
  useWindowContext: true,
  contextProvider: 'none',
  recordingMode: 'toggle',
  startDelay: 0,
  audioDevice: '',
  customPromptDate: '',
  grammarCheck: true,  // on by default for accuracy (zero-edit parity); matches the Tauri default
  autoFormatContent: true,  // format spoken lists/emails/passages automatically
  silenceDetection: true,
  silenceThreshold: 0.02,
  silenceDuration: 2000,
  captureScreenshots: false,  // disabled by default for privacy
  autoHideOverlay: false,
  transcriptionLanguage: 'en',
  appProfiles: {},
  voiceCommandsEnabled: true,
  dictationHistoryContext: 2,
  tone: 'casual',
  noiseReduction: true,
  whisperMode: false,
  crashReportingEnabled: false,
  autoUpdateEnabled: true,
};

const store = new Store<EchoSettings>({
  name: 'settings',
  defaults,
});

export function getSetting<K extends keyof EchoSettings>(key: K): EchoSettings[K] {
  return store.get(key);
}

export function setSetting<K extends keyof EchoSettings>(key: K, value: EchoSettings[K]): void {
  store.set(key, value);
}

export function getAllSettings(): EchoSettings {
  return store.store;
}
