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

// All dev helpers sign under one identifier so that — with a real (self-signed)
// "Echo" identity — macOS collapses them into a single "Echo" entry per TCC list
// and the grant persists across rebuilds. See scripts/setup-dev-signing.sh.
const SHARED_IDENTIFIER: &str = "com.echo.app";
const SIGNING_CN: &str = "Echo";
const DEV_KEYCHAIN: &str = "echo-dev.keychain";
const DEV_KEYCHAIN_PASS: &str = "echo-dev";

/// SHA-1 of our self-signed "Echo" code-signing identity, if the dev-signing cert
/// has been installed (`scripts/setup-dev-signing.sh`). We sign by hash rather than
/// by name because `codesign --sign Echo` does substring matching and would be
/// ambiguous with other certs like "Echo Dev Signing".
fn echo_signing_hash() -> Option<String> {
    let out = Command::new("security")
        .args(["find-identity", "-p", "codesigning"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        // Format: `  1) <40-hex-hash> "Name" (status)`
        let name = line
            .split_once('"')
            .and_then(|(_, rest)| rest.split_once('"'))
            .map(|(name, _)| name);
        if name == Some(SIGNING_CN) {
            if let Some(hash) = line
                .split_whitespace()
                .find(|t| t.len() == 40 && t.chars().all(|c| c.is_ascii_hexdigit()))
            {
                return Some(hash.to_string());
            }
        }
    }
    None
}

/// The dev keychain isn't the login keychain, so it locks on reboot and codesign
/// can't reach the private key until it's unlocked. Best-effort unlock; harmless
/// if the keychain doesn't exist (ad-hoc fallback path).
fn unlock_dev_keychain() {
    let _ = Command::new("security")
        .args(["unlock-keychain", "-p", DEV_KEYCHAIN_PASS, DEV_KEYCHAIN])
        .output();
}

/// Re-sign a helper with a stable identity so its TCC grants persist.
///
/// If the self-signed "Echo" identity is installed, sign with it under the shared
/// identifier so every helper shows up as a single "Echo" in Privacy & Security and
/// the grant survives rebuilds. Otherwise fall back to a normal (non-linker) ad-hoc
/// signature with a per-helper identifier — better than swiftc's linker-signed default
/// (which macOS treats as second-class for TCC), but still keyed per-cdhash.
///
/// Best-effort: a codesign failure is logged but never blocks using the binary.
fn codesign_stable(binary_path: &Path, binary_name: &str) {
    let path_str = binary_path.to_str().unwrap_or("");
    let (sign, identifier, desc) = match echo_signing_hash() {
        Some(hash) => {
            unlock_dev_keychain();
            (hash, SHARED_IDENTIFIER.to_string(), "Echo".to_string())
        }
        None => ("-".to_string(), format!("com.echo.{}", binary_name), "ad-hoc".to_string()),
    };

    let result = Command::new("codesign")
        .args(["--force", "--sign", &sign, "--identifier", &identifier, path_str])
        .output();

    match result {
        Ok(o) if o.status.success() => {
            log::info!("[swift-binary] {} re-signed as {} ({})", binary_name, identifier, desc);
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

/// Ensure an already-present helper carries the signature we want, re-signing if not.
///
/// swiftc stamps fresh helpers with a *linker-signed* ad-hoc signature that macOS
/// treats as second-class for TCC (grants drift to "denied"). And `codesign_stable`
/// historically only ran on the fresh-compile path, so a helper compiled once and
/// never recompiled kept the wrong signature forever. Re-sign when the current
/// signature doesn't match the desired scheme (cert-signed if the "Echo" identity is
/// installed, otherwise a proper non-linker ad-hoc signature).
fn ensure_stable_signature(binary_path: &Path, binary_name: &str) {
    let info = Command::new("codesign")
        .args(["-dvvv"])
        .arg(binary_path)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stderr).into_owned())
        .unwrap_or_default();

    let needs_resign = match echo_signing_hash() {
        // Want the cert signature under the shared identifier.
        Some(_) => !(info.contains(&format!("Identifier={}", SHARED_IDENTIFIER))
            && info.contains(&format!("Authority={}", SIGNING_CN))),
        // No cert: want a proper ad-hoc signature with the per-helper identifier.
        None => info.contains("linker-signed")
            || !info.contains(&format!("Identifier=com.echo.{}", binary_name)),
    };

    if needs_resign {
        log::info!("[swift-binary] {} signature stale — re-signing for stable TCC identity", binary_name);
        codesign_stable(binary_path, binary_name);
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
                ensure_stable_signature(&binary_path, binary_name);
                return true;
            }
        } else {
            ensure_stable_signature(&binary_path, binary_name);
            return true;
        }
    }

    let source = match source_path {
        Some(p) => p,
        None => {
            if binary_path.exists() { return true; }
            log::debug!("[swift-binary] Source not found for {}", binary_name);
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
