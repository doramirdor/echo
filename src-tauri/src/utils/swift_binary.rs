use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::thread::JoinHandle;

fn bin_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
        .join("Library/Application Support/echo/bin")
}

pub fn get_binary_path(name: &str) -> PathBuf {
    bin_dir().join(name)
}

/// Re-sign a freshly compiled helper with an explicit, stable ad-hoc identity.
///
/// `swiftc` emits a *linker-signed* ad-hoc signature (`flags=…adhoc,linker-signed`);
/// macOS treats those as second-class for TCC, so the `fn-monitor` Input Monitoring
/// grant (keyed by cdhash) keeps drifting back to "denied" and the fn hotkey silently
/// stops receiving events. Re-signing with `codesign --sign -` and a deterministic
/// identifier produces a normal ad-hoc signature whose cdhash is stable across
/// identical rebuilds, so the grant persists once the user approves it.
///
/// Best-effort: a codesign failure is logged but never blocks using the binary
/// (an unsigned/linker-signed helper still runs, it just re-triggers the prompt).
fn codesign_stable(binary_path: &Path, binary_name: &str) {
    let identifier = format!("com.echo.{}", binary_name);
    let path_str = binary_path.to_str().unwrap_or("");
    let result = Command::new("codesign")
        .args(["--force", "--sign", "-", "--identifier", &identifier, path_str])
        .output();

    match result {
        Ok(o) if o.status.success() => {
            log::info!("[swift-binary] {} re-signed as {}", binary_name, identifier);
        }
        Ok(o) => {
            log::warn!(
                "[swift-binary] codesign of {} failed: {}",
                binary_name,
                String::from_utf8_lossy(&o.stderr).trim()
            );
        }
        Err(e) => {
            log::warn!("[swift-binary] codesign of {} failed: {}", binary_name, e);
        }
    }
}

pub fn ensure_swift_binary(binary_name: &str, source_relative_path: &str) -> bool {
    let binary_path = bin_dir().join(binary_name);

    // Try to find source relative to the executable, then fall back to cwd
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));

    let source_path = exe_dir.as_ref()
        .map(|d| d.join("../../../").join(source_relative_path))
        .filter(|p| p.exists())
        .or_else(|| {
            let cwd = std::env::current_dir().ok()?;
            let p = cwd.join(source_relative_path);
            if p.exists() { Some(p) } else { None }
        });

    if binary_path.exists() {
        if let Some(ref src) = source_path {
            let needs_recompile = fs::metadata(&binary_path)
                .and_then(|bm| fs::metadata(src).map(|sm| (bm, sm)))
                .map(|(bm, sm)| {
                    sm.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH) > bm.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH)
                })
                .unwrap_or(false);

            if !needs_recompile {
                return true;
            }
        } else {
            return true;
        }
    }

    let source = match source_path {
        Some(p) => p,
        None => {
            if binary_path.exists() { return true; }
            log::warn!("[swift-binary] Source not found for {}", binary_name);
            return false;
        }
    };

    fs::create_dir_all(bin_dir()).ok();

    log::info!("[swift-binary] Compiling {}...", binary_name);
    let result = Command::new("swiftc")
        .args(["-O", "-o", binary_path.to_str().unwrap_or(""), source.to_str().unwrap_or("")])
        .output();

    match result {
        Ok(output) if output.status.success() => {
            log::info!("[swift-binary] {} compiled successfully", binary_name);
            codesign_stable(&binary_path, binary_name);
            true
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            log::error!("[swift-binary] Failed to compile {}: {}", binary_name, stderr);
            binary_path.exists()
        }
        Err(e) => {
            log::error!("[swift-binary] Failed to compile {}: {}", binary_name, e);
            binary_path.exists()
        }
    }
}

// In-flight async compiles, deduped by binary name so a startup pre-compile
// and a stale-triggered recompile can never run two swiftc processes writing
// the same output path.
fn in_flight_compiles() -> &'static Mutex<HashSet<String>> {
    static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Async variant of `ensure_swift_binary` for startup pre-compilation —
/// compiling five helpers synchronously blocks the calling (startup) thread for
/// seconds. This spawns the compile on a background `std::thread` and returns a
/// `JoinHandle<bool>` the caller may join or drop (fire-and-forget).
///
/// Deduped by binary name: if the same binary is already compiling, returns
/// `None` rather than spawning a second `swiftc` that would race on the output
/// path. The in-flight marker is cleared when the compile finishes.
pub fn ensure_swift_binary_async(
    binary_name: &str,
    source_relative_path: &str,
) -> Option<JoinHandle<bool>> {
    {
        let mut in_flight = match in_flight_compiles().lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if !in_flight.insert(binary_name.to_string()) {
            // Already compiling this binary — dedup.
            return None;
        }
    }

    let name = binary_name.to_string();
    let source = source_relative_path.to_string();
    Some(std::thread::spawn(move || {
        let result = ensure_swift_binary(&name, &source);
        let mut in_flight = match in_flight_compiles().lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        in_flight.remove(&name);
        result
    }))
}
