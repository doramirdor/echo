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
                content[tail_start(&content, max_bytes)..].to_string()
            } else {
                content
            }
        }
        Err(_) => String::new(),
    }
}

/// Byte offset to start the last `max_bytes` of `content` from, snapped forward
/// to a character boundary. The log is full of multi-byte characters — the em
/// dash in user-facing error messages, and any non-English dictation echoed by
/// `[pipeline] RAW:` — so a raw `len - max_bytes` offset can land mid-character
/// and panic the slice, taking out "Copy debug logs" exactly when someone is
/// trying to report a bug.
fn tail_start(content: &str, max_bytes: usize) -> usize {
    let mut start = content.len().saturating_sub(max_bytes);
    while start < content.len() && !content.is_char_boundary(start) {
        start += 1;
    }
    start
}

#[cfg(test)]
mod tests {
    use super::tail_start;

    #[test]
    fn tail_start_snaps_off_a_multibyte_character() {
        // "—" is 3 bytes; cutting at 1 or 2 bytes into it must move forward to
        // the next boundary rather than produce a panicking offset.
        let s = "ab—cd";
        assert_eq!(s.len(), 7);
        for max in 1..=s.len() {
            let start = tail_start(s, max);
            assert!(s.is_char_boundary(start), "offset {} splits a character", start);
            // Never drops more than the requested tail's worth of content.
            assert!(start <= s.len());
            let _ = &s[start..]; // would panic on a bad boundary
        }
    }

    #[test]
    fn tail_start_is_exact_on_ascii() {
        let s = "0123456789";
        assert_eq!(tail_start(s, 4), 6);
        assert_eq!(&s[tail_start(s, 4)..], "6789");
        // Asking for more than there is keeps the whole string.
        assert_eq!(tail_start(s, 100), 0);
    }
}
