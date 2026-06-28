use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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

fn model_path(model_name: &str) -> PathBuf {
    models_dir().join(model_name)
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
    (binary_path().exists(), model_path(model_name).exists())
}

pub fn transcribe(wav_path: &Path, model_name: &str) -> Result<String, String> {
    let bin = binary_path();
    let model = model_path(model_name);

    if !bin.exists() {
        return Err(format!("whisper.cpp binary not found at {:?}. Build it in Settings.", bin));
    }
    if !model.exists() {
        return Err(format!("Whisper model not found at {:?}. Download it in Settings.", model));
    }

    let output = Command::new(bin.to_str().unwrap_or(""))
        .args([
            "-m", model.to_str().unwrap_or(""),
            "-f", wav_path.to_str().unwrap_or(""),
            "--no-timestamps",
            "-nt",
            "-l", "en",
        ])
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
    progress_cb: impl Fn(u32) + Send + 'static,
) -> Result<(), String> {
    let model = model_path(model_name);
    if model.exists() {
        log::info!("[whisper] Model {} already exists", model_name);
        return Ok(());
    }

    fs::create_dir_all(models_dir()).map_err(|e| e.to_string())?;

    let url = format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}", model_name);
    log::info!("[whisper] Downloading from {}...", url);

    let client = reqwest::Client::new();
    let response = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    let total = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;

    let tmp_path = model.with_extension("bin.tmp");
    let mut file = fs::File::create(&tmp_path).map_err(|e| format!("Create file: {}", e))?;

    let bytes = response.bytes()
        .await
        .map_err(|e| format!("Read failed: {}", e))?;

    use std::io::Write;
    file.write_all(&bytes).map_err(|e| format!("Write failed: {}", e))?;
    progress_cb(100);

    fs::rename(&tmp_path, &model).map_err(|e| format!("Rename failed: {}", e))?;
    log::info!("[whisper] Model downloaded to {:?}", model);
    Ok(())
}

pub async fn build_binary(progress_cb: impl Fn(&str) + Send + 'static) -> Result<(), String> {
    let bin = binary_path();
    if bin.exists() {
        progress_cb("Binary already exists");
        return Ok(());
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

    progress_cb("Done! whisper-cli installed.");
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
