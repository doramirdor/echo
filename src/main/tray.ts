import { app, Tray, Menu, nativeImage, NativeImage } from 'electron';
import { exec } from 'child_process';
import * as path from 'path';
import { AppState, EchoState } from './appState';
import { getSetting, setSetting, STTEngine, Tone } from './settings/settings';
import { isOverlayVisible, toggleOverlay, hideOverlayAfterActivity } from './overlay';

const trayIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'assets', 'tray')
  : path.join(__dirname, '..', '..', 'assets', 'tray');

let pulseTimer: ReturnType<typeof setInterval> | null = null;
let successFlashTimer: ReturnType<typeof setTimeout> | null = null;

// system_profiler takes hundreds of ms, so the input-device list is cached
// with a TTL and refreshed off the main thread (mirrors the soxAvailable
// memoization in recorder.ts). Never enumerated on state changes or pulse
// ticks — only when the context menu is actually built.
const DEVICE_CACHE_TTL_MS = 30_000;
let cachedInputDevices: string[] = [];
let devicesFetchedAt = 0;
let deviceRefreshInFlight = false;

function refreshInputDevicesAsync(): void {
  if (deviceRefreshInFlight) return;
  deviceRefreshInFlight = true;
  exec(
    'system_profiler SPAudioDataType 2>/dev/null',
    { encoding: 'utf-8', timeout: 5000 },
    (err, stdout) => {
      deviceRefreshInFlight = false;
      devicesFetchedAt = Date.now();
      if (err || !stdout) return;
      // Same names AudioRecorder.listInputDevices extracts, without execSync.
      const devices = (stdout.match(/Input Source: .+/g) ?? [])
        .map(m => m.replace('Input Source: ', '').trim())
        .filter(Boolean);
      for (const m of stdout.match(/Device Name: .+/g) ?? []) {
        const name = m.replace('Device Name: ', '').trim();
        if (name && !devices.includes(name)) devices.push(name);
      }
      cachedInputDevices = devices;
    },
  );
}

function getInputDevices(): string[] {
  if (Date.now() - devicesFetchedAt >= DEVICE_CACHE_TTL_MS) refreshInputDevicesAsync();
  return cachedInputDevices;
}

function createTrayIcon(state: EchoState): NativeImage {
  if (state === EchoState.Recording) {
    return nativeImage.createFromPath(path.join(trayIconPath, 'IconRecordingNew.png'));
  }
  const icon = nativeImage.createFromPath(path.join(trayIconPath, 'IconTemplateNew.png'));
  icon.setTemplateImage(true);
  return icon;
}

let tray: Tray | null = null;

function startPulse(): void {
  stopPulse();
  let on = true;
  // Only toggles the title — never rebuilds the menu or enumerates devices.
  pulseTimer = setInterval(() => {
    if (!tray) return;
    tray.setTitle(on ? ' \u25CF' : ' \u25CB');
    on = !on;
  }, 600);
}

function stopPulse(): void {
  if (pulseTimer) {
    clearInterval(pulseTimer);
    pulseTimer = null;
  }
}

function flashSuccess(): void {
  if (!tray) return;
  tray.setTitle(' \u2713');
  if (successFlashTimer) clearTimeout(successFlashTimer);
  successFlashTimer = setTimeout(() => {
    if (tray) {
      tray.setTitle('');
    }
    successFlashTimer = null;
  }, 1500);
}

function formatHotkey(): string {
  return getSetting('hotkey').replace('CommandOrControl', '\u2318').replace('Shift', '\u21E7').replace('+', '');
}

export function createTray(
  appState: AppState,
  toggle: () => void,
  openSettings: () => void,
): Tray {
  tray = new Tray(createTrayIcon(EchoState.Idle));
  tray.setToolTip('Echo');

  // Warm the device cache so the first right-click already has entries.
  refreshInputDevicesAsync();

  // Left-click opens the settings window directly; right-click (or control-click)
  // shows the menu. We intentionally do NOT call setContextMenu — on macOS that
  // would bind the menu to left-click and swallow the click handler below.
  // The menu is built on demand so state labels and checkboxes are always fresh.
  tray.on('click', () => {
    openSettings();
  });
  tray.on('right-click', () => {
    tray?.popUpContextMenu(buildTrayMenu(appState, toggle, openSettings));
  });

  updateTray(appState, toggle, openSettings);

  // Flash checkmark on successful insertion
  appState.on('stateChange', (state: string, previous: string) => {
    if (previous === EchoState.Inserting && state === EchoState.Idle) {
      flashSuccess();
    }
  });

  return tray;
}

export function updateTray(
  appState: AppState,
  _toggle: () => void,
  _openSettings: () => void,
): void {
  if (!tray) return;

  try {
    tray.setImage(createTrayIcon(appState.state));
  } catch { /* icon may not load on all systems */ }

  if (appState.state === EchoState.Recording) {
    if (!pulseTimer) startPulse();
  } else {
    stopPulse();
  }

  // Any state other than Idle makes a pending success flash obsolete.
  if (appState.state !== EchoState.Idle && successFlashTimer) {
    clearTimeout(successFlashTimer);
    successFlashTimer = null;
  }

  switch (appState.state) {
    case EchoState.Recording:
      tray.setTitle(' \u25CF');
      break;
    case EchoState.Transcribing:
    case EchoState.Refining:
    case EchoState.Inserting:
      tray.setTitle(' ...');
      break;
    case EchoState.Error:
      tray.setTitle('');
      break;
    default:
      if (!successFlashTimer) tray.setTitle('');
      break;
  }

  tray.setToolTip(`Echo \u2014 Press ${formatHotkey()} to record`);
}

function buildTrayMenu(
  appState: AppState,
  toggle: () => void,
  openSettings: () => void,
): Menu {
  const hotkey = formatHotkey();

  const stateLabel = appState.state === EchoState.Recording
    ? '\uD83D\uDD34 Recording... (press hotkey to stop)'
    : appState.state === EchoState.Idle
    ? `Ready \u2014 ${hotkey} to record`
    : appState.state === EchoState.Error
    ? `\u274C ${appState.errorMessage}`
    : '\u23F3 Processing...';

  const audioDevices = getInputDevices();
  const currentDevice = getSetting('audioDevice');

  return Menu.buildFromTemplate([
    { label: stateLabel, enabled: false },
    { type: 'separator' },
    {
      label: appState.isRecording ? `Stop Recording (${hotkey})` : `Start Recording (${hotkey})`,
      click: toggle,
      enabled: !appState.isBusy || appState.isRecording,
    },
    { type: 'separator' },
    {
      label: isOverlayVisible() ? 'Hide Overlay' : 'Show Overlay',
      click: toggleOverlay,
      accelerator: getSetting('overlayHotkey'),
    },
    {
      label: 'Auto-hide Overlay',
      type: 'checkbox',
      checked: getSetting('autoHideOverlay'),
      click: () => {
        const newValue = !getSetting('autoHideOverlay');
        setSetting('autoHideOverlay', newValue);
        if (newValue) hideOverlayAfterActivity();
      },
    },
    { type: 'separator' },
    {
      label: 'Microphone',
      submenu: Menu.buildFromTemplate([
        {
          label: 'System Default',
          type: 'radio',
          checked: !currentDevice,
          click: () => { setSetting('audioDevice', ''); },
        },
        ...audioDevices.map(device => ({
          label: device,
          type: 'radio' as const,
          checked: currentDevice === device,
          click: () => { setSetting('audioDevice', device); },
        })),
      ]),
    },
    {
      label: 'STT Engine',
      submenu: Menu.buildFromTemplate(([
        { id: 'groq', label: 'Groq Cloud (Whisper Large V3)' },
        { id: 'whisper', label: 'Local Whisper.cpp' },
        { id: 'macos', label: 'macOS Native' },
        { id: 'deepgram', label: 'Deepgram' },
        { id: 'openai-whisper', label: 'OpenAI Whisper API' },
      ] as const).map(item => ({
        label: item.label,
        type: 'radio' as const,
        checked: getSetting('sttEngine') === item.id,
        click: () => {
          setSetting('sttEngine', item.id as STTEngine);
        },
      }))),
    },
    { type: 'separator' },
    {
      label: 'Fix Grammar',
      type: 'checkbox',
      checked: getSetting('grammarCheck'),
      click: () => {
        setSetting('grammarCheck', !getSetting('grammarCheck'));
      },
    },
    {
      label: 'Tone',
      submenu: Menu.buildFromTemplate(([
        { id: 'casual', label: 'Casual' },
        { id: 'formal', label: 'Formal' },
      ] as const).map(item => ({
        label: item.label,
        type: 'radio' as const,
        checked: getSetting('tone') === item.id,
        click: () => {
          setSetting('tone', item.id as Tone);
        },
      }))),
    },
    { type: 'separator' },
    {
      label: 'Settings...',
      click: openSettings,
    },
    { type: 'separator' },
    {
      label: `Last: ${appState.lastRefinedText?.substring(0, 50) ?? 'nothing yet'}`,
      enabled: false,
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}
