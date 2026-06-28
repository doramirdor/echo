import { autoUpdater } from 'electron-updater';
import { Notification, app } from 'electron';
import { getSetting } from './settings/settings';
import { logger } from './utils/logger';

export function setupAutoUpdater(): void {
  if (!getSetting('autoUpdateEnabled')) return;
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    logger.info('updater', `Update available: ${info.version}`);
    new Notification({
      title: 'Echo Update Available',
      body: `Version ${info.version} is available. Downloading...`,
      silent: true,
    }).show();
    autoUpdater.downloadUpdate();
  });

  autoUpdater.on('update-downloaded', (info) => {
    logger.info('updater', `Update downloaded: ${info.version}`);
    new Notification({
      title: 'Echo Update Ready',
      body: `Version ${info.version} will install on next restart.`,
      silent: true,
    }).show();
  });

  autoUpdater.on('error', (err) => {
    logger.warn('updater', `Update check failed: ${err.message}`);
  });

  // Check on launch (non-blocking)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => { /* silent */ });
  }, 10000);
}
