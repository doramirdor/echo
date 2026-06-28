import { BrowserWindow, ipcMain, screen } from 'electron';
import * as path from 'path';
import { EchoState } from './appState';
import { getSetting } from './settings/settings';
import { TranscriptionSegment } from './transcription/deepgramTranscriber';

let overlayWindow: BrowserWindow | null = null;
let overlayVisible = true;

function positionOverlayOnFocusedDisplay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  // Place overlay on the display containing the cursor (proxy for focused window)
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { width, height, x, y } = display.workArea;

  overlayWindow.setPosition(
    Math.round(x + width / 2 - 170),
    Math.round(y + height - 160),
  );
}

export function createOverlay(): void {
  const display = screen.getPrimaryDisplay();
  const { width, height, x: areaX, y: areaY } = display.workArea;

  overlayWindow = new BrowserWindow({
    width: 340,
    height: 160,
    x: Math.round(areaX + width / 2 - 170),
    y: Math.round(areaY + height - 160),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    movable: true,
    focusable: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Click-through on transparent areas; renderer toggles this on mouse enter/leave
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  // Make window actually receive clicks
  overlayWindow.webContents.on('before-input-event', (event, input) => {
    console.log('[overlay] Input event:', input.type);
  });

  // Force reload on every launch to bypass cache
  const htmlPath = path.join(__dirname, '..', 'renderer', 'overlay.html');
  overlayWindow.loadFile(htmlPath).then(() => {
    overlayWindow?.webContents.reloadIgnoringCache();
  });

  // Let renderer toggle click-through when mouse enters/leaves the container
  ipcMain.on('overlay-mouse-enter', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setIgnoreMouseEvents(false);
    }
  });
  ipcMain.on('overlay-mouse-leave', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  // Drag support: renderer sends screen-coordinate deltas
  let dragStartPos = { x: 0, y: 0 };
  ipcMain.on('overlay-drag-start', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      const [x, y] = overlayWindow.getPosition();
      dragStartPos = { x, y };
    }
  });
  ipcMain.on('overlay-drag-move', (_e, deltaX: number, deltaY: number) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setPosition(dragStartPos.x + deltaX, dragStartPos.y + deltaY);
    }
  });

  overlayWindow.on('closed', () => { overlayWindow = null; });
}

export function sendOverlayState(state: EchoState, data: { lastResult?: string; rawResult?: string; error?: string }): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send('state-change', state, data);
}

export function sendLiveTranscript(text: string): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send('live-transcript', text);
}

export function sendAudioLevel(level: number): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send('audio-level', level);
}

export function sendConfidenceSegments(segments: TranscriptionSegment[]): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send('confidence-segments', segments);
}

export function sendOverlayProgress(state: string, data: { wordCount?: number; eta?: number }): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send('progress', state, data);
}


export function toggleOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (overlayVisible) {
    overlayWindow.hide();
    overlayVisible = false;
    console.log('[echo] Overlay hidden');
  } else {
    overlayWindow.showInactive();
    overlayVisible = true;
    console.log('[echo] Overlay shown');
  }
}

/** Show overlay temporarily for recording (only when auto-hide is enabled) */
export function showOverlayForActivity(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  positionOverlayOnFocusedDisplay();
  if (getSetting('autoHideOverlay') && !overlayVisible) {
    overlayWindow.showInactive();
    overlayVisible = true;
    console.log('[echo] Overlay auto-shown for activity');
  }
}

/** Hide overlay after activity ends (only when auto-hide is enabled) */
export function hideOverlayAfterActivity(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (getSetting('autoHideOverlay') && overlayVisible) {
    overlayWindow.hide();
    overlayVisible = false;
    console.log('[echo] Overlay auto-hidden');
  }
}

export function isOverlayVisible(): boolean {
  return overlayVisible;
}

export function resizeOverlay(_expanded: boolean): void {
  // No-op: new design uses CSS transitions for size changes
  return;
}
