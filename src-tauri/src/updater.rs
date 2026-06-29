//! Auto-updater — mirrors `src/main/updater.ts` (electron-updater).
//!
//! Gated on the `auto_update_enabled` setting and on being a packaged (release)
//! build. About 10s after launch it runs a single, non-blocking check; if an
//! update is available it downloads and installs it, then notifies the user that
//! it will apply on the next restart. It does NOT force a relaunch — matching
//! Electron's `autoInstallOnAppQuit = true` (install applies on next launch).

use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

/// Schedule the launch-time update check. `enabled` mirrors the
/// `auto_update_enabled` setting (Electron's `autoUpdateEnabled`).
pub fn setup_auto_updater(app: AppHandle, enabled: bool) {
    // Skip in dev builds (mirrors Electron's `!app.isPackaged` guard) — there are
    // no signed updater artifacts to pull, so a check would only ever error.
    if cfg!(debug_assertions) {
        return;
    }
    if !enabled {
        return;
    }

    tauri::async_runtime::spawn(async move {
        // Single non-blocking check ~10s after launch; no periodic re-check.
        tokio::time::sleep(Duration::from_secs(10)).await;
        if let Err(e) = run_update_check(&app).await {
            // Warn-only — update failures are never surfaced to the user.
            log::warn!("[updater] Update check failed: {}", e);
        }
    });
}

async fn run_update_check(app: &AppHandle) -> tauri_plugin_updater::Result<()> {
    match app.updater()?.check().await? {
        Some(update) => {
            let version = update.version.clone();
            log::info!("[updater] Update available: {}", version);
            let _ = app
                .notification()
                .builder()
                .title("Echo Update Available")
                .body(format!("Version {} is available. Downloading...", version))
                .show();

            update
                .download_and_install(
                    |_chunk, _total| { /* progress; no UI needed for parity */ },
                    || log::info!("[updater] Download finished"),
                )
                .await?;

            // Electron defers the apply to next quit/relaunch — we mirror that by
            // notifying rather than calling app.restart().
            log::info!("[updater] Update downloaded: {}", version);
            let _ = app
                .notification()
                .builder()
                .title("Echo Update Ready")
                .body(format!("Version {} will install on next restart.", version))
                .show();
        }
        None => log::info!("[updater] No update available"),
    }
    Ok(())
}
