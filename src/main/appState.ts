import { EventEmitter } from 'events';

export enum EchoState {
  Idle = 'idle',
  Recording = 'recording',
  Transcribing = 'transcribing',
  Refining = 'refining',

  Inserting = 'inserting',
  Error = 'error',
}

export class AppState extends EventEmitter {
  private _state: EchoState = EchoState.Idle;
  private _errorMessage: string | null = null;
  private _lastTranscription: string | null = null;
  private _lastRefinedText: string | null = null;
  private _sourceApp: string | null = null;
  private _screenshotPath: string | null = null;
  private _contextPromise: Promise<string> | null = null;
  private _existingFieldText: string | null = null;
  private _existingFieldTextAfter: string | null = null;

  get sourceApp(): string | null {
    return this._sourceApp;
  }

  set sourceApp(app: string | null) {
    this._sourceApp = app;
  }

  get screenshotPath(): string | null {
    return this._screenshotPath;
  }

  set screenshotPath(path: string | null) {
    this._screenshotPath = path;
  }

  get contextPromise(): Promise<string> | null {
    return this._contextPromise;
  }

  set contextPromise(promise: Promise<string> | null) {
    this._contextPromise = promise;
  }

  get existingFieldText(): string | null {
    return this._existingFieldText;
  }

  set existingFieldText(text: string | null) {
    this._existingFieldText = text;
  }

  /** Text after the caret in the focused field (for continuation context). */
  get existingFieldTextAfter(): string | null {
    return this._existingFieldTextAfter;
  }

  set existingFieldTextAfter(text: string | null) {
    this._existingFieldTextAfter = text;
  }

  get state(): EchoState {
    return this._state;
  }

  get errorMessage(): string | null {
    return this._errorMessage;
  }

  get lastTranscription(): string | null {
    return this._lastTranscription;
  }

  get lastRefinedText(): string | null {
    return this._lastRefinedText;
  }

  setState(state: EchoState, errorMessage?: string): void {
    const previous = this._state;
    this._state = state;
    this._errorMessage = errorMessage ?? null;
    console.log(`[echo] ${previous} → ${state}${errorMessage ? ` (${errorMessage})` : ''}`);
    this.emit('stateChange', state, previous);
  }

  setTranscription(raw: string, refined: string): void {
    this._lastTranscription = raw;
    this._lastRefinedText = refined;
  }

  get isRecording(): boolean {
    return this._state === EchoState.Recording;
  }

  get isBusy(): boolean {
    return this._state !== EchoState.Idle && this._state !== EchoState.Error;
  }
}
