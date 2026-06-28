use std::fs;
use std::io::Write;
use std::path::PathBuf;

const MAX_LOG_SIZE: u64 = 5 * 1024 * 1024;

fn log_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
        .join("Library/Application Support/echo/logs")
}

fn log_file() -> PathBuf {
    log_dir().join("echo.log")
}

pub fn write_log(level: &str, tag: &str, message: &str) {
    let line = format!("[{}] [{}] [{}] {}\n", chrono::Utc::now().to_rfc3339(), level.to_uppercase(), tag, message);

    let dir = log_dir();
    fs::create_dir_all(&dir).ok();

    let path = log_file();
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > MAX_LOG_SIZE {
            let rotated = path.with_extension("log.1");
            let _ = fs::rename(&path, &rotated);
        }
    }

    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

pub fn read_recent_logs(max_bytes: usize) -> String {
    let path = log_file();
    if !path.exists() { return String::new(); }
    match fs::read_to_string(&path) {
        Ok(content) => {
            if content.len() > max_bytes {
                content[content.len() - max_bytes..].to_string()
            } else {
                content
            }
        }
        Err(_) => String::new(),
    }
}
