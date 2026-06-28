use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn bin_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
        .join("Library/Application Support/echo/bin")
}

pub fn get_binary_path(name: &str) -> PathBuf {
    bin_dir().join(name)
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
