import { app, Tray, Menu, nativeImage, NativeImage } from 'electron';
import * as path from 'path';
import { AppState, EchoState } from './appState';
import { getSetting, setSetting, STTEngine, Tone } from './settings/settings';
import { isOverlayVisible, toggleOverlay, hideOverlayAfterActivity } from './overlay';
import { AudioRecorder } from './audio/recorder';

const trayIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'assets', 'tray')
  : path.join(__dirname, '..', '..', 'assets', 'tray');

let pulseTimer: ReturnType<typeof setInterval> | null = null;
let successFlashTimer: ReturnType<typeof setTimeout> | null = null;

function createTrayIcon(state: EchoState): NativeImage {
  if (state === EchoState.Recording) {
    return nativeImage.createFromPath(path.join(trayIconPath, 'IconRecordingNew.png'));
  }
  const icon = nativeImage.createFromPath(path.join(trayIconPath, 'IconTemplateNew.png'));
  icon.setTemplateImage(true);
  return icon;
}

let tray: Tray | null = null;
// The context menu is popped up on right-click only (see createTray). We hold a
// reference here so updateTray can refresh it without binding it to left-click.
let trayMenu: Menu | null = null;

function startPulse(appState: AppState, toggle: () => void, openSettings: () => void): void {
  stopPulse();
  let on = true;
  pulseTimer = setInterval(() => {
    if (!tray) return;
    tray.setTitle(on ? ' \u25CF' : ' \u25CB');
    on = !on;
    updateTray(appState, toggle, openSettings, true);
  }, 600);
}

function stopPulse(): void {
  if (pulseTimer) {
    clearInterval(pulseTimer);
    pulseTimer = null;
  }
}

function flashSuccess(_appState: AppState, _toggle: () => void, _openSettings: () => void): void {
  if (!tray) return;
  tray.setTitle(' \u2713');
  if (successFlashTimer) clearTimeout(successFlashTimer);
  successFlashTimer = setTimeout(() => {
    if (tray) {
      tray.setTitle('');
    }
  }, 1500);
}

export function createTray(
  appState: AppState,
  toggle: () => void,
  openSettings: () => void,
): Tray {
  tray = new Tray(createTrayIcon(EchoState.Idle));
  tray.setToolTip('Echo');

  // Left-click opens the settings window directly; right-click (or control-click)
  // shows the menu. We intentionally do NOT call setContextMenu — on macOS that
  // would bind the menu to left-click and swallow the click handler below.
  tray.on('click', () => {
    openSettings();
  });
  tray.on('right-click', () => {
    if (trayMenu) tray?.popUpContextMenu(trayMenu);
  });

  updateTray(appState, toggle, openSettings);

  // Flash checkmark on successful insertion
  appState.on('stateChange', (state: string, previous: string) => {
    if (previous === EchoState.Inserting && state === EchoState.Idle) {
      flashSuccess(appState, toggle, openSettings);
    }
  });

  return tray;
}

export function updateTray(
  appState: AppState,
  toggle: () => void,
  openSettings: () => void,
  skipPulse = false,
): void {
  if (!tray) return;

  const hotkey = getSetting('hotkey').replace('CommandOrControl', '\u2318').replace('Shift', '\u21E7').replace('+', '');

  try {
    tray.setImage(createTrayIcon(appState.state));
  } catch { /* icon may not load on all systems */ }

  if (!skipPulse) {
    if (appState.state === EchoState.Recording) {
      startPulse(appState, toggle, openSettings);
    } else {
      stopPulse();
    }
  }

  switch (appState.state) {
    case EchoState.Recording:
      if (!pulseTimer) tray.setTitle(' Rec');
      break;
    case EchoState.Transcribing:
    case EchoState.Refining:
    case EchoState.Inserting:
      stopPulse();
      tray.setTitle(' ...');
      break;
    default:
      if (!successFlashTimer) tray.setTitle('');
      break;
  }

  tray.setToolTip(`Echo \u2014 Press ${hotkey} to record`);

  const stateLabel = appState.state === EchoState.Recording
    ? '\uD83D\uDD34 Recording... (press hotkey to stop)'
    : appState.state === EchoState.Idle
    ? `Ready \u2014 ${hotkey} to record`
    : appState.state === EchoState.Error
    ? `\u274C ${appState.errorMessage}`
    : '\u23F3 Processing...';

  const audioDevices = AudioRecorder.listInputDevices();
  const currentDevice = getSetting('audioDevice');

  const contextMenu = Menu.buildFromTemplate([
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
        updateTray(appState, toggle, openSettings);
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
          click: () => { setSetting('audioDevice', ''); updateTray(appState, toggle, openSettings); },
        },
        ...audioDevices.map(device => ({
          label: device,
          type: 'radio' as const,
          checked: currentDevice === device,
          click: () => { setSetting('audioDevice', device); updateTray(appState, toggle, openSettings); },
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
          updateTray(appState, toggle, openSettings);
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
        updateTray(appState, toggle, openSettings);
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
          updateTray(appState, toggle, openSettings);
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

  // Store for right-click popup rather than binding to left-click via setContextMenu.
  trayMenu = contextMenu;
}
