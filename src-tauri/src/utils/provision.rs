use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

// First-run provisioning for packaged builds.
//
// A shareable .app bundles prebuilt native helpers, `whisper-cli`, and a Whisper
// model under `Contents/Resources/{bin,models}` (staged by scripts/package-mac.sh).
// On first launch we copy those into `~/Library/Application Support/echo/{bin,models}`
// — the exact paths the app already reads — so a fresh Mac needs no Xcode tools,
// Homebrew, git/cmake, or network to start dictating. In a dev build there is no
// bundle, so this is a no-op and the app falls back to compiling/downloading.

/// `Contents/Resources` of the running .app, or None when not bundled (dev).
fn bundled_resources_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // .../Echo.app/Contents/MacOS/Echo  ->  .../Echo.app/Contents/Resources
    let resources = exe.parent()?.parent()?.join("Resources");
    if resources.is_dir() {
        Some(resources)
    } else {
        None
    }
}

fn echo_support_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join("Library/Application Support/echo")
}

/// Copy each file in `src` into `dst` unless it already exists there. When
/// `executable` is set, copied files get mode 0o755 — Tauri can drop the +x bit
/// while bundling, and the Swift helpers / whisper-cli must be runnable.
fn seed_dir(src: &Path, dst: &Path, executable: bool) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("create {:?}: {}", dst, e))?;
    for entry in fs::read_dir(src).map_err(|e| format!("read {:?}: {}", src, e))?.flatten() {
        let from = entry.path();
        if !from.is_file() {
            continue;
        }
        let to = dst.join(entry.file_name());
        if to.exists() {
            continue;
        }
        fs::copy(&from, &to).map_err(|e| format!("copy {:?} -> {:?}: {}", from, to, e))?;
        if executable {
            let _ = fs::set_permissions(&to, fs::Permissions::from_mode(0o755));
        }
        log::info!("[provision] seeded {:?}", to);
    }
    Ok(())
}

/// Seed bundled prebuilts into the app-support dir on first run of a packaged
/// build. Best-effort: logs and continues on any error (the app can still
/// compile/download on demand). No-op in dev.
pub fn provision_bundled_assets() {
    let resources = match bundled_resources_dir() {
        Some(d) => d,
        None => return,
    };
    let support = echo_support_dir();

    let bin_src = resources.join("bin");
    if bin_src.is_dir() {
        if let Err(e) = seed_dir(&bin_src, &support.join("bin"), true) {
            log::warn!("[provision] bin: {}", e);
        }
    }

    let models_src = resources.join("models");
    if models_src.is_dir() {
        if let Err(e) = seed_dir(&models_src, &support.join("models"), false) {
            log::warn!("[provision] models: {}", e);
        }
    }
}
