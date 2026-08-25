use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use super::whisper::DownloadProgress;

// GGUF conversions of NVIDIA's Parakeet models, published for parakeet.cpp.
const MODEL_BASE_URL: &str = "https://huggingface.co/mudler/parakeet-cpp-gguf/resolve/main/";
const PARAKEET_REPO: &str = "https://github.com/mudler/parakeet.cpp";

pub const DEFAULT_PARAKEET_MODEL: &str = "tdt-0.6b-v3-q8_0.gguf";

/// Logged once per process — the bias prompt is dropped on every dictation.
static WARNED_ABOUT_BIAS: AtomicBool = AtomicBool::new(false);

fn models_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
        .join("Library/Application Support/echo/models")
}

fn bin_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
        .join("Library/Application Support/echo/bin")
}

fn binary_path() -> PathBuf {
    bin_dir().join("parakeet-cli")
}

fn model_path(model_name: &str) -> PathBuf {
    models_dir().join(model_name)
}

/// Model names arrive from the renderer and settings — keep them bare gguf
/// filenames so they can't escape the models dir or rewrite the download URL
/// (mirrors the check in parakeetService.ts).
fn is_valid_model_name(name: &str) -> bool {
    name.ends_with(".gguf")
        && name.len() > ".gguf".len()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub struct ParakeetModel {
    pub name: &'static str,
    pub label: &'static str,
    pub size: &'static str,
}

/// The Parakeet models we expose. A deliberately short slice of the upstream
/// collection: the tiny English model for low-end machines, and the 0.6B TDT
/// models that are the reason to pick Parakeet at all.
///
/// v2 is English-only; v3 covers 25 European languages + Japanese at comparable
/// accuracy, so it's the default — picking v2 silently breaks every non-English
/// user of `transcription_language`.
pub const PARAKEET_MODELS: &[ParakeetModel] = &[
    ParakeetModel { name: "tdt_ctc-110m-q8_0.gguf", label: "Parakeet Tiny 110M (English)", size: "~169MB" },
    ParakeetModel { name: "tdt-0.6b-v2-q8_0.gguf", label: "Parakeet 0.6B v2 (English only)", size: "~861MB" },
    ParakeetModel { name: "tdt-0.6b-v3-q5_k.gguf", label: "Parakeet 0.6B v3 (multilingual, smaller)", size: "~707MB" },
    ParakeetModel { name: "tdt-0.6b-v3-q8_0.gguf", label: "Parakeet 0.6B v3 (multilingual, recommended)", size: "~897MB" },
];

pub fn is_ready(model_name: &str) -> (bool, bool) {
    let model = is_valid_model_name(model_name) && model_path(model_name).exists();
    (binary_path().exists(), model)
}

/// Pull the transcript out of `parakeet-cli --json` output.
///
/// The CLI emits `{"text":"...","words":[...],"tokens":[...]}`, but ggml-family
/// binaries are prone to writing load/backend chatter alongside it, so parse
/// defensively: whole-buffer JSON first, then the last JSON-looking line, then
/// give up and use the raw text. Mirrors `parseParakeetOutput` in
/// parakeetService.ts.
pub fn parse_output(stdout: &str) -> String {
    let raw = stdout.trim();
    if raw.is_empty() {
        return String::new();
    }

    let from_json = |candidate: &str| -> Option<String> {
        serde_json::from_str::<serde_json::Value>(candidate)
            .ok()
            .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(|s| s.trim().to_string()))
    };

    if let Some(text) = from_json(raw) {
        return text;
    }

    // Scan from the end: the transcript JSON is the last thing the CLI prints.
    for line in raw.lines().rev() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        if let Some(text) = from_json(line) {
            return text;
        }
    }

    raw.to_string()
}

/// Transcribe a WAV with the parakeet.cpp CLI.
///
/// Note there is no counterpart to whisper's `--prompt`: Parakeet is a
/// transducer and takes no initial prompt, so vocabulary/jargon biasing cannot
/// happen during decoding the way it does for whisper. `bias_prompt` is accepted
/// only so we can warn once that STT-level biasing is inactive; terms get fixed
/// downstream by the LLM refiner.
pub fn transcribe(wav_path: &Path, model_name: &str, language: &str, bias_prompt: &str) -> Result<String, String> {
    if !is_valid_model_name(model_name) {
        return Err(format!("Invalid parakeet model name: {}", model_name));
    }
    let bin = binary_path();
    let model = model_path(model_name);

    if !bin.exists() {
        return Err(format!("parakeet.cpp binary not found at {:?}. Build it in Settings.", bin));
    }
    if !model.exists() {
        return Err(format!("Parakeet model not found at {:?}. Download it in Settings.", model));
    }

    if !bias_prompt.is_empty() && !WARNED_ABOUT_BIAS.swap(true, Ordering::Relaxed) {
        log::warn!(
            "[parakeet] Parakeet takes no initial prompt — STT vocabulary biasing is \
             inactive for this engine; jargon is corrected by the LLM refiner only."
        );
    }

    let lang = if language.is_empty() { "auto" } else { language };
    let args: Vec<&str> = vec![
        "transcribe",
        "--model", model.to_str().unwrap_or(""),
        "--input", wav_path.to_str().unwrap_or(""),
        "--json",
        "--lang", lang,
    ];

    let output = Command::new(bin.to_str().unwrap_or(""))
        .args(&args)
        .output()
        .map_err(|e| format!("Parakeet transcription failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Parakeet failed: {}", stderr));
    }

    let text = parse_output(&String::from_utf8_lossy(&output.stdout));
    log::info!("[parakeet] Transcribed: \"{}\"", text);
    Ok(text)
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
                .filter(|n| n.ends_with(".gguf"))
                .collect()
        })
        .unwrap_or_default()
}

pub async fn download_model(
    model_name: &str,
    progress_cb: impl Fn(DownloadProgress) + Send + 'static,
) -> Result<(), String> {
    if !is_valid_model_name(model_name) {
        return Err(format!("Invalid parakeet model name: {}", model_name));
    }
    let model = model_path(model_name);
    if model.exists() {
        log::info!("[parakeet] Model {} already exists", model_name);
        return Ok(());
    }

    fs::create_dir_all(models_dir()).map_err(|e| e.to_string())?;

    let url = format!("{}{}", MODEL_BASE_URL, model_name);
    log::info!("[parakeet] Downloading from {}...", url);

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

    let tmp_path = model.with_extension("gguf.tmp");
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
    log::info!("[parakeet] Model downloaded to {:?} ({} bytes)", model, downloaded);
    Ok(())
}

/// Build the parakeet.cpp binary from source. Requires git and cmake.
/// Metal is enabled explicitly — it's the whole point on Apple Silicon.
pub async fn build_binary(progress_cb: impl Fn(&str) + Send + 'static) -> Result<(), String> {
    let bin = binary_path();
    if bin.exists() {
        progress_cb("Binary already exists");
        return Ok(());
    }

    let tmp_dir = std::env::temp_dir().join("echo-parakeet-build");
    fs::create_dir_all(bin_dir()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    let repo_dir = tmp_dir.join("parakeet.cpp");

    // --recursive: parakeet.cpp vendors ggml as a submodule.
    if !repo_dir.exists() {
        progress_cb("Cloning parakeet.cpp...");
        run_cmd("git", &["clone", "--depth", "1", "--recursive", PARAKEET_REPO], &tmp_dir)?;
    }

    progress_cb("Configuring build...");
    run_cmd("cmake", &["-B", "build", "-DCMAKE_BUILD_TYPE=Release", "-DPARAKEET_GGML_METAL=ON"], &repo_dir)?;

    let cpus = num_cpus().to_string();
    progress_cb("Compiling parakeet.cpp...");
    run_cmd("cmake", &["--build", "build", "--config", "Release", "-j", &cpus], &repo_dir)?;

    let built = repo_dir.join("build/examples/cli/parakeet-cli");
    if !built.exists() {
        return Err("Build succeeded but parakeet-cli binary not found".into());
    }
    fs::copy(&built, &bin).map_err(|e| format!("Copy binary: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).ok();
    }

    progress_cb("Done! parakeet-cli installed.");
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors tests/parakeet.test.ts — keep the two in step.

    #[test]
    fn parses_clean_json() {
        assert_eq!(parse_output(r#"{"text":"hello world","words":[]}"#), "hello world");
    }

    #[test]
    fn finds_transcript_after_load_chatter() {
        let stdout = "ggml_metal_init: allocating\nparakeet: loading model from m.gguf\n{\"text\":\"deploy the staging cluster\"}";
        assert_eq!(parse_output(stdout), "deploy the staging cluster");
    }

    #[test]
    fn takes_the_last_json_object() {
        assert_eq!(parse_output("{\"text\":\"first pass\"}\n{\"text\":\"final pass\"}"), "final pass");
    }

    #[test]
    fn falls_back_to_raw_text() {
        assert_eq!(parse_output("  just a bare transcript  "), "just a bare transcript");
    }

    #[test]
    fn ignores_json_without_a_text_field() {
        assert_eq!(parse_output(r#"{"error":"bad model"}"#), r#"{"error":"bad model"}"#);
    }

    #[test]
    fn empty_output_is_empty() {
        assert_eq!(parse_output("   "), "");
    }

    #[test]
    fn rejects_model_names_that_escape_the_models_dir() {
        assert!(!is_valid_model_name("../../../etc/passwd"));
        assert!(!is_valid_model_name("evil.gguf/../../x"));
        assert!(!is_valid_model_name("ggml-base.en.bin"));
        assert!(is_valid_model_name(DEFAULT_PARAKEET_MODEL));
    }

    #[test]
    fn default_model_is_multilingual_v3_and_is_offered() {
        assert!(DEFAULT_PARAKEET_MODEL.contains("v3"));
        assert!(PARAKEET_MODELS.iter().any(|m| m.name == DEFAULT_PARAKEET_MODEL));
    }

    #[test]
    fn trims_whitespace_inside_json_text_field() {
        assert_eq!(parse_output(r#"{"text":"  padded  "}"#), "padded");
    }

    #[test]
    fn transcribe_surfaces_invalid_model_name() {
        // The model-name guard runs before any binary/model filesystem check, so
        // an invalid name is rejected without needing parakeet-cli installed.
        let err = transcribe(Path::new("/tmp/a.wav"), "nope.txt", "", "").unwrap_err();
        assert!(err.contains("Invalid parakeet model name"));
    }
}
