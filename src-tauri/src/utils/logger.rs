use std::fs;
use std::io::Write;
use std::path::PathBuf;

const MAX_LOG_SIZE: u64 = 5 * 1024 * 1024;

/// A logger that mirrors every record to stderr (like env_logger) *and* appends
/// it to `~/Library/Application Support/echo/logs/echo.log`, so the in-app log
/// viewer (`get_logs` / `copy_logs`) has something to read.
struct FileLogger {
    level: log::LevelFilter,
}

impl log::Log for FileLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= self.level
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let level = record.level();
        let target = record.target();
        let msg = record.args();
        // Console (stderr) — keep the familiar env_logger-style line.
        eprintln!("[{}] {} {}", level, target, msg);
        // Persistent file.
        write_log(&level.to_string(), target, &msg.to_string());
    }

    fn flush(&self) {}
}

/// Install the file-backed logger. Honors the `RUST_LOG` env var loosely:
/// when it contains "debug"/"trace" the corresponding level is enabled,
/// otherwise defaults to Info.
pub fn init() {
    let level = match std::env::var("RUST_LOG").unwrap_or_default().to_lowercase() {
        ref s if s.contains("trace") => log::LevelFilter::Trace,
        ref s if s.contains("debug") => log::LevelFilter::Debug,
        ref s if s.contains("warn") => log::LevelFilter::Warn,
        ref s if s.contains("error") => log::LevelFilter::Error,
        _ => log::LevelFilter::Info,
    };
    let logger = Box::new(FileLogger { level });
    if log::set_boxed_logger(logger).is_ok() {
        log::set_max_level(level);
    }
}

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
