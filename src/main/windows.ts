import { BrowserWindow, screen } from 'electron';
import * as path from 'path';
import { setSetting } from './settings/settings';

let settingsWindow: BrowserWindow | null = null;
let onboardingWindow: BrowserWindow | null = null;

export function openSettings(): void {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 960,
    height: 780,
    minWidth: 640,
    minHeight: 500,
    title: 'Echo',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow;
}

export function showOnboarding(): void {
  if (onboardingWindow) {
    onboardingWindow.focus();
    return;
  }

  // Grow the window ~20% over the old 520×680 so the taller steps (LLM engine
  // list + API key) fit without scrolling, but never exceed the display's work
  // area on smaller screens — leave a small margin so it isn't edge-to-edge.
  const { width: availW, height: availH } = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(624, availW - 40);
  const height = Math.min(816, availH - 40);

  onboardingWindow = new BrowserWindow({
    width,
    height,
    title: 'Welcome to Echo',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  onboardingWindow.loadFile(path.join(__dirname, '..', 'renderer', 'onboarding.html'));
  onboardingWindow.on('closed', () => { onboardingWindow = null; });
}

export function getOnboardingWindow(): BrowserWindow | null {
  return onboardingWindow;
}

export function closeOnboarding(): void {
  setSetting('onboardingComplete', true);
  if (onboardingWindow) {
    onboardingWindow.close();
    onboardingWindow = null;
  }
}
