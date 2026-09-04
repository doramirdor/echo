use std::fs;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// A download-progress tick emitted to the renderer. `total` is 0 when the
/// server sends no Content-Length; `bytes_per_sec` is a short rolling average.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub percent: u32,
    pub downloaded: u64,
    pub total: u64,
    pub bytes_per_sec: u64,
}

fn models_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
        .join("Library/Application Support/echo/models")
}

fn bin_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
        .join("Library/Application Support/echo/bin")
}

fn binary_path() -> PathBuf {
    bin_dir().join("whisper-cli")
}

fn server_binary_path() -> PathBuf {
    bin_dir().join("whisper-server")
}

fn model_path(model_name: &str) -> PathBuf {
    models_dir().join(model_name)
}

/// Model names arrive from the renderer and settings — keep them bare ggml
/// filenames so they can't escape the models dir or rewrite the download URL
/// (mirrors the check in whisperService.ts).
fn is_valid_model_name(name: &str) -> bool {
    name.starts_with("ggml-")
        && name.ends_with(".bin")
        && name.len() > "ggml-.bin".len()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub struct WhisperModel {
    pub name: &'static str,
    pub label: &'static str,
    pub size: &'static str,
}

pub const WHISPER_MODELS: &[WhisperModel] = &[
    WhisperModel { name: "ggml-tiny.en.bin", label: "Tiny (English)", size: "~75MB" },
    WhisperModel { name: "ggml-base.en.bin", label: "Base (English)", size: "~142MB" },
    WhisperModel { name: "ggml-small.en.bin", label: "Small (English)", size: "~488MB" },
    WhisperModel { name: "ggml-medium.en.bin", label: "Medium (English)", size: "~1.5GB" },
    WhisperModel { name: "ggml-large-v3-turbo.bin", label: "Large v3 Turbo", size: "~1.6GB" },
];

pub fn is_ready(model_name: &str) -> (bool, bool) {
    let model = is_valid_model_name(model_name) && model_path(model_name).exists();
    (binary_path().exists(), model)
}

pub fn transcribe(wav_path: &Path, model_name: &str, language: &str, prompt: &str) -> Result<String, String> {
    if !is_valid_model_name(model_name) {
        return Err(format!("Invalid whisper model name: {}", model_name));
    }
    let bin = binary_path();
    let model = model_path(model_name);

    if !bin.exists() {
        return Err(format!("whisper.cpp binary not found at {:?}. Build it in Settings.", bin));
    }
    if !model.exists() {
        return Err(format!("Whisper model not found at {:?}. Download it in Settings.", model));
    }

    let lang = if language.is_empty() { "en" } else { language };
    // Run multi-threaded for a multi-core speedup (mirrors whisperService.ts:
    // threads = max(1, cpus - 1), leaving a core for the UI).
    let threads = std::cmp::max(1, num_cpus().saturating_sub(1)).to_string();
    let mut args: Vec<&str> = vec![
        "-m", model.to_str().unwrap_or(""),
        "-f", wav_path.to_str().unwrap_or(""),
        "--no-timestamps",
        "-nt",
        "-t", threads.as_str(),
        "-l", lang,
    ];
    // Bias decoding toward the user's vocabulary/jargon (whisper.cpp `--prompt`).
    if !prompt.is_empty() {
        args.push("--prompt");
        args.push(prompt);
    }

    let output = Command::new(bin.to_str().unwrap_or(""))
        .args(&args)
        .output()
        .map_err(|e| format!("Whisper transcription failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Whisper failed: {}", stderr));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    log::info!("[whisper] Transcribed: \"{}\"", text);
    Ok(text)
}

// ── Warm whisper-server path ────────────────────────────────────────────────
// whisper-server keeps the model + Metal context loaded between dictations,
// skipping the 300-800ms cold init the CLI pays every run. Any spawn/HTTP
// failure falls back silently to the one-shot CLI (`transcribe` above). Mirrors
// the WarmServer logic in `whisperService.ts`.

struct WarmServer {
    model_path: PathBuf,
    port: u16,
    child: std::process::Child,
}

static SERVER: LazyLock<Mutex<Option<WarmServer>>> = LazyLock::new(|| Mutex::new(None));
/// Set once the server binary is missing or fails to come up, so we don't retry
/// spawning it on every dictation.
static SERVER_DISABLED: AtomicBool = AtomicBool::new(false);
static BOUNDARY_SEQ: AtomicU64 = AtomicU64::new(0);

/// Kill the warm whisper-server child, if any. Called on app exit.
pub fn shutdown() {
    if let Ok(mut guard) = SERVER.lock() {
        if let Some(mut s) = guard.take() {
            let _ = s.child.kill();
        }
    }
}

/// Transcribe via the warm server. Returns `None` on any failure so the caller
/// falls back to the CLI path.
pub async fn transcribe_via_server(
    wav_path: &Path,
    model_name: &str,
    language: &str,
    prompt: &str,
) -> Option<String> {
    if SERVER_DISABLED.load(Ordering::Relaxed) {
        return None;
    }
    if !is_valid_model_name(model_name) {
        return None;
    }
    let model = model_path(model_name);
    if !model.exists() {
        return None;
    }

    let port = ensure_server(model).await?;
    let lang = if language.is_empty() { "en".to_string() } else { language.to_string() };
    let prompt = prompt.to_string();

    match request_inference(port, wav_path, &lang, &prompt).await {
        Some(text) => {
            log::info!("[whisper] Transcribed (warm): \"{}\"", text);
            Some(text)
        }
        None => {
            // The server may have died — clear it so the next dictation restarts it.
            shutdown();
            None
        }
    }
}

/// Return the port of a running server for `model`, spawning one if needed. The
/// blocking spawn + readiness wait runs off the async runtime.
async fn ensure_server(model: PathBuf) -> Option<u16> {
    {
        let guard = SERVER.lock().ok()?;
        if let Some(s) = guard.as_ref() {
            if s.model_path == model {
                return Some(s.port);
            }
        }
    }
    tokio::task::spawn_blocking(move || start_server_blocking(&model))
        .await
        .ok()
        .flatten()
}

fn start_server_blocking(model: &Path) -> Option<u16> {
    let bin = server_binary_path();
    if !bin.exists() {
        SERVER_DISABLED.store(true, Ordering::Relaxed);
        log::info!("[whisper] whisper-server not installed — using one-shot CLI");
        return None;
    }

    // A different model is loaded — restart on the new one.
    {
        let mut guard = SERVER.lock().ok()?;
        if let Some(s) = guard.as_mut() {
            if s.model_path == model {
                return Some(s.port);
            }
            let _ = s.child.kill();
            *guard = None;
        }
    }

    let port = find_free_port()?;
    let threads = std::cmp::max(1, num_cpus().saturating_sub(1)).to_string();
    let child = Command::new(&bin)
        .args([
            "-m", model.to_str()?,
            "--host", "127.0.0.1",
            "--port", &port.to_string(),
            "-t", &threads,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    if !wait_for_port(port, 30_000) {
        let mut child = child;
        let _ = child.kill();
        SERVER_DISABLED.store(true, Ordering::Relaxed);
        log::info!("[whisper] whisper-server failed to start — using one-shot CLI");
        return None;
    }

    log::info!("[whisper] whisper-server warm on 127.0.0.1:{}", port);
    let mut guard = SERVER.lock().ok()?;
    *guard = Some(WarmServer { model_path: model.to_path_buf(), port, child });
    Some(port)
}

fn find_free_port() -> Option<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").ok()?;
    listener.local_addr().ok().map(|a| a.port())
}

fn wait_for_port(port: u16, timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    let addr = format!("127.0.0.1:{}", port);
    while std::time::Instant::now() < deadline {
        if let Ok(addr) = addr.parse() {
            if TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok() {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

async fn request_inference(port: u16, wav_path: &Path, language: &str, prompt: &str) -> Option<String> {
    let wav = fs::read(wav_path).ok()?;

    let seq = BOUNDARY_SEQ.fetch_add(1, Ordering::Relaxed);
    let boundary = format!("----echo-whisper-{}-{}", port, seq);

    let mut body: Vec<u8> = Vec::with_capacity(wav.len() + 512);
    let mut field = |name: &str, value: &str| {
        body.extend_from_slice(
            format!(
                "--{}\r\nContent-Disposition: form-data; name=\"{}\"\r\n\r\n{}\r\n",
                boundary, name, value
            )
            .as_bytes(),
        );
    };
    field("response_format", "text");
    field("language", language);
    if !prompt.is_empty() {
        field("prompt", prompt);
    }
    body.extend_from_slice(
        format!(
            "--{}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n",
            boundary
        )
        .as_bytes(),
    );
    body.extend_from_slice(&wav);
    body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://127.0.0.1:{}/inference", port))
        .header("Content-Type", format!("multipart/form-data; boundary={}", boundary))
        .timeout(Duration::from_secs(120))
        .body(body)
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    Some(text.trim().to_string())
}

pub fn list_downloaded_models() -> Vec<String> {
    let dir = models_dir();
    if !dir.exists() {
        return vec![];
    }
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.starts_with("ggml-") && n.ends_with(".bin"))
                .collect()
        })
        .unwrap_or_default()
}

pub async fn download_model(
    model_name: &str,
    progress_cb: impl Fn(DownloadProgress) + Send + 'static,
) -> Result<(), String> {
    if !is_valid_model_name(model_name) {
        return Err(format!("Invalid whisper model name: {}", model_name));
    }
    let model = model_path(model_name);
    if model.exists() {
        log::info!("[whisper] Model {} already exists", model_name);
        return Ok(());
    }

    fs::create_dir_all(models_dir()).map_err(|e| e.to_string())?;

    let url = format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}", model_name);
    log::info!("[whisper] Downloading from {}...", url);

    let client = reqwest::Client::new();
    let mut response = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed: HTTP {}", response.status()));
    }

    let total = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;

    let tmp_path = model.with_extension("bin.tmp");
    let mut file = fs::File::create(&tmp_path).map_err(|e| format!("Create file: {}", e))?;

    use std::io::Write;
    // Throttle progress to ~10 ticks/sec and derive a rolling transfer speed
    // from the bytes moved since the last tick, so the UI can show bytes + MB/s.
    let mut last_emit = Instant::now();
    let mut last_bytes: u64 = 0;
    let percent_of = |done: u64| -> u32 {
        if total > 0 { ((done * 100) / total).min(100) as u32 } else { 0 }
    };
    // Stream the body to disk so large models don't buffer in memory and the
    // UI gets incremental download-progress updates.
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("Read failed: {}", e))? {
        file.write_all(&chunk).map_err(|e| format!("Write failed: {}", e))?;
        downloaded += chunk.len() as u64;
        let dt = last_emit.elapsed().as_secs_f64();
        if dt >= 0.1 {
            let bytes_per_sec = if dt > 0.0 { ((downloaded - last_bytes) as f64 / dt) as u64 } else { 0 };
            last_emit = Instant::now();
            last_bytes = downloaded;
            progress_cb(DownloadProgress { percent: percent_of(downloaded), downloaded, total, bytes_per_sec });
        }
    }
    progress_cb(DownloadProgress { percent: 100, downloaded, total, bytes_per_sec: 0 });

    fs::rename(&tmp_path, &model).map_err(|e| format!("Rename failed: {}", e))?;
    log::info!("[whisper] Model downloaded to {:?} ({} bytes)", model, downloaded);
    Ok(())
}

pub async fn build_binary(progress_cb: impl Fn(&str) + Send + 'static) -> Result<(), String> {
    let bin = binary_path();
    if bin.exists() {
        progress_cb("Binary already exists");
        return Ok(());
    }

    if !cmd_exists("git") {
        return Err("git is not installed. Install Xcode Command Line Tools: xcode-select --install".into());
    }
    if !cmd_exists("cmake") {
        return Err("cmake is not installed. Install it with: brew install cmake".into());
    }

    let tmp_dir = std::env::temp_dir().join("echo-whisper-build");
    fs::create_dir_all(bin_dir()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    let repo_dir = tmp_dir.join("whisper.cpp");

    if !repo_dir.exists() {
        progress_cb("Cloning whisper.cpp...");
        run_cmd("git", &["clone", "--depth", "1", "https://github.com/ggerganov/whisper.cpp.git"], &tmp_dir)?;
    }

    progress_cb("Configuring build...");
    run_cmd("cmake", &["-B", "build", "-DCMAKE_BUILD_TYPE=Release"], &repo_dir)?;

    let cpus = num_cpus().to_string();
    progress_cb("Compiling whisper.cpp...");
    run_cmd("cmake", &["--build", "build", "--config", "Release", "-j", &cpus], &repo_dir)?;

    let built = repo_dir.join("build/bin/whisper-cli");
    if !built.exists() {
        return Err("Build succeeded but whisper-cli binary not found".into());
    }
    fs::copy(&built, &bin).map_err(|e| format!("Copy binary: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).ok();
    }

    // The same build produces whisper-server, which powers the warm-transcription
    // path. Best-effort: the CLI path works without it.
    let built_server = repo_dir.join("build/bin/whisper-server");
    if built_server.exists() {
        let server_bin = server_binary_path();
        if fs::copy(&built_server, &server_bin).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&server_bin, fs::Permissions::from_mode(0o755)).ok();
            }
        }
    }

    progress_cb("Done! whisper-cli installed.");
    Ok(())
}

fn cmd_exists(name: &str) -> bool {
    Command::new(name).arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
}

fn run_cmd(cmd: &str, args: &[&str], cwd: &Path) -> Result<(), String> {
    let path_env = format!(
        "{}:/opt/homebrew/bin:/usr/local/bin",
        std::env::var("PATH").unwrap_or_default()
    );
    let output = Command::new(cmd)
        .args(args)
        .current_dir(cwd)
        .env("PATH", &path_env)
        .output()
        .map_err(|e| format!("{} failed: {}", cmd, e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{} failed: {}", cmd, stderr));
    }
    Ok(())
}

fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}
