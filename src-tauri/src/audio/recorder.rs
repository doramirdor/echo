use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{watch, Mutex, Notify};

type JoinHandle = tauri::async_runtime::JoinHandle<()>;

pub struct AudioRecorder {
    output_path: PathBuf,
    raw_data: Arc<Mutex<Vec<u8>>>,
    level_tx: watch::Sender<f32>,
    level_rx: watch::Receiver<f32>,
    stop_signal: Arc<Notify>,
    collect_handle: Option<JoinHandle>,
    pid: Arc<Mutex<Option<u32>>>,
    is_recording: bool,
}

impl AudioRecorder {
    pub fn new() -> Self {
        let (tx, rx) = watch::channel(0.0f32);
        Self {
            output_path: PathBuf::new(),
            raw_data: Arc::new(Mutex::new(Vec::new())),
            level_tx: tx,
            level_rx: rx,
            stop_signal: Arc::new(Notify::new()),
            collect_handle: None,
            pid: Arc::new(Mutex::new(None)),
            is_recording: false,
        }
    }

    pub fn level_receiver(&self) -> watch::Receiver<f32> {
        self.level_rx.clone()
    }

    pub fn start(&mut self, device_name: Option<&str>) -> Result<(), String> {
        if self.is_recording {
            return Err("Already recording".into());
        }

        let tmp = std::env::temp_dir().join(format!("echo-{}.wav", chrono::Utc::now().timestamp_millis()));
        self.output_path = tmp;

        let mut cmd = Command::new("rec");
        cmd.args(["-r", "16000", "-c", "1", "-b", "16", "-t", "raw", "-"]);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.stdin(Stdio::null());

        if let Some(dev) = device_name {
            cmd.env("AUDIODEV", dev);
            log::info!("[recorder] Using audio device: {}", dev);
        }

        let mut child = cmd.spawn().map_err(|e| {
            format!("Failed to start sox/rec: {}. Install sox: brew install sox", e)
        })?;

        let child_pid = child.id();
        {
            let pid = self.pid.clone();
            tauri::async_runtime::spawn(async move {
                *pid.lock().await = child_pid;
            });
        }

        let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;

        let raw_data = self.raw_data.clone();
        let level_tx = self.level_tx.clone();
        let stop_signal = self.stop_signal.clone();
        let pid_ref = self.pid.clone();

        {
            let raw_data_ref = raw_data.clone();
            raw_data_ref.try_lock().map(|mut d| d.clear()).ok();
        }

        let handle = tauri::async_runtime::spawn(async move {
            let mut stdout = stdout;
            let mut buf = [0u8; 4096];

            loop {
                tokio::select! {
                    result = stdout.read(&mut buf) => {
                        match result {
                            Ok(0) => break,
                            Ok(n) => {
                                raw_data.lock().await.extend_from_slice(&buf[..n]);
                                let level = compute_rms(&buf[..n]);
                                let _ = level_tx.send(level);
                            }
                            Err(_) => break,
                        }
                    }
                    _ = stop_signal.notified() => {
                        if let Some(pid) = *pid_ref.lock().await {
                            unsafe { libc::kill(pid as i32, libc::SIGTERM); }
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        while let Ok(n) = stdout.read(&mut buf).await {
                            if n == 0 { break; }
                            raw_data.lock().await.extend_from_slice(&buf[..n]);
                        }
                        break;
                    }
                }
            }

            let _ = child.wait().await;
            *pid_ref.lock().await = None;
        });

        self.collect_handle = Some(handle);
        self.is_recording = true;

        log::info!("[recorder] Recording started");
        Ok(())
    }

    pub async fn stop(&mut self) -> Result<PathBuf, String> {
        if !self.is_recording {
            return Err("Not recording".into());
        }

        self.stop_signal.notify_one();

        if let Some(handle) = self.collect_handle.take() {
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                handle,
            ).await;
        }

        self.is_recording = false;
        let _ = self.level_tx.send(0.0);

        self.write_wav().await?;

        let size = std::fs::metadata(&self.output_path)
            .map(|m| m.len())
            .unwrap_or(0);
        log::info!("[recorder] Saved {:.1}KB to {:?}", size as f64 / 1024.0, self.output_path);
        Ok(self.output_path.clone())
    }

    async fn write_wav(&self) -> Result<(), String> {
        let raw_data = self.raw_data.lock().await;
        let data_size = raw_data.len() as u32;
        let mut header = vec![0u8; 44];

        header[0..4].copy_from_slice(b"RIFF");
        header[4..8].copy_from_slice(&(36 + data_size).to_le_bytes());
        header[8..12].copy_from_slice(b"WAVE");
        header[12..16].copy_from_slice(b"fmt ");
        header[16..20].copy_from_slice(&16u32.to_le_bytes());
        header[20..22].copy_from_slice(&1u16.to_le_bytes());
        header[22..24].copy_from_slice(&1u16.to_le_bytes());
        header[24..28].copy_from_slice(&16000u32.to_le_bytes());
        header[28..32].copy_from_slice(&32000u32.to_le_bytes());
        header[32..34].copy_from_slice(&2u16.to_le_bytes());
        header[34..36].copy_from_slice(&16u16.to_le_bytes());
        header[36..40].copy_from_slice(b"data");
        header[40..44].copy_from_slice(&data_size.to_le_bytes());

        let mut file = std::fs::File::create(&self.output_path)
            .map_err(|e| format!("Failed to create WAV: {}", e))?;
        file.write_all(&header).map_err(|e| format!("Failed to write header: {}", e))?;
        file.write_all(&raw_data).map_err(|e| format!("Failed to write data: {}", e))?;

        Ok(())
    }

    pub fn force_stop(&mut self) {
        if let Some(handle) = self.collect_handle.take() {
            handle.abort();
        }
        let pid = self.pid.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(pid) = *pid.lock().await {
                unsafe { libc::kill(pid as i32, libc::SIGKILL); }
            }
        });
        self.is_recording = false;
    }

    pub fn post_process(wav_path: &std::path::Path, noise_reduction: bool, whisper_mode: bool) -> PathBuf {
        let processed = wav_path.with_extension("clean.wav");
        let mut input_path = wav_path.to_path_buf();

        if noise_reduction {
            let profile_path = wav_path.with_extension("noise.prof");
            let denoised_path = wav_path.with_extension("denoised.wav");
            let prof_str = profile_path.to_str().unwrap_or("");
            let denoised_str = denoised_path.to_str().unwrap_or("");
            let input_str = input_path.to_str().unwrap_or("");

            let profile_ok = std::process::Command::new("sox")
                .args([input_str, "-n", "trim", "0", "0.5", "noiseprof", prof_str])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);

            if profile_ok {
                let denoise_ok = std::process::Command::new("sox")
                    .args([input_str, denoised_str, "noisered", prof_str, "0.21"])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);

                if denoise_ok {
                    input_path = denoised_path;
                    log::info!("[recorder] Noise reduction applied");
                } else {
                    log::warn!("[recorder] Noise reduction failed, continuing without");
                }
            }
            let _ = std::fs::remove_file(&profile_path);
        }

        let input_str = input_path.to_str().unwrap_or("");
        let processed_str = processed.to_str().unwrap_or("");

        let mut args: Vec<&str> = vec![input_str, processed_str];
        if whisper_mode {
            args.extend_from_slice(&[
                "gain", "20",
                "compand", "0.02,0.20", "-60,-60,-30,-10,-20,-8,-5,-2", "-8",
                "highpass", "100",
                "lowpass", "4000",
            ]);
        } else {
            args.extend_from_slice(&["gain", "10", "highpass", "200", "lowpass", "3500"]);
        }
        args.extend_from_slice(&["norm", "-1"]);

        let result = std::process::Command::new("sox").args(&args).output();

        let denoised_path = wav_path.with_extension("denoised.wav");
        if input_path == denoised_path {
            let _ = std::fs::remove_file(&denoised_path);
        }

        match result {
            Ok(output) if output.status.success() => {
                log::info!("[recorder] Audio cleaned (noise_red={}, whisper={})", noise_reduction, whisper_mode);
                processed
            }
            _ => {
                log::warn!("[recorder] Post-processing failed, using original");
                wav_path.to_path_buf()
            }
        }
    }

    /// Compress the cleaned WAV before uploading to a cloud STT engine, to cut
    /// upload bytes. Mirrors AudioRecorder.encodeForUpload in
    /// src/main/audio/recorder.ts. Controlled by ECHO_STT_UPLOAD_FORMAT
    /// (default "flac"); falls back to the original WAV on any error.
    pub fn encode_for_upload(wav_path: &std::path::Path) -> PathBuf {
        let fmt = std::env::var("ECHO_STT_UPLOAD_FORMAT")
            .unwrap_or_else(|_| "flac".into())
            .to_lowercase();
        if fmt == "wav" {
            return wav_path.to_path_buf();
        }
        if !["flac", "ogg", "opus"].contains(&fmt.as_str()) {
            log::warn!("[recorder] Unknown ECHO_STT_UPLOAD_FORMAT=\"{}\", uploading wav", fmt);
            return wav_path.to_path_buf();
        }

        let out_path = wav_path.with_extension(&fmt);
        let input_str = wav_path.to_str().unwrap_or("");
        let out_str = out_path.to_str().unwrap_or("");

        // FLAC: -C 8 = max lossless compression. OGG (Vorbis): -C 4 ≈ quality 4.
        let mut args: Vec<&str> = vec![input_str];
        match fmt.as_str() {
            "flac" => args.extend_from_slice(&["-C", "8"]),
            "ogg" => args.extend_from_slice(&["-C", "4"]),
            _ => {}
        }
        args.push(out_str);

        let start = std::time::Instant::now();
        match std::process::Command::new("sox").args(&args).output() {
            Ok(output) if output.status.success() => {
                let before = std::fs::metadata(wav_path).map(|m| m.len()).unwrap_or(0);
                let after = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
                let pct = if before > 0 { 100.0 * (1.0 - after as f64 / before as f64) } else { 0.0 };
                log::info!(
                    "[recorder] Upload encode {}: {}KB → {}KB (-{:.0}%, {}ms)",
                    fmt, before / 1024, after / 1024, pct, start.elapsed().as_millis()
                );
                out_path
            }
            _ => {
                log::warn!("[recorder] Upload encode to {} failed, using wav", fmt);
                wav_path.to_path_buf()
            }
        }
    }

    pub fn check_dependencies() -> (bool, String) {
        match std::process::Command::new("which").arg("rec").output() {
            Ok(output) if output.status.success() => (true, "sox is installed".into()),
            _ => (false, "sox is not installed. Run: brew install sox".into()),
        }
    }

    pub fn list_input_devices() -> Vec<String> {
        let output = std::process::Command::new("bash")
            .args(["-c", "system_profiler SPAudioDataType 2>/dev/null | grep 'Input Source:' | sed 's/.*Input Source: //'"])
            .output();

        match output {
            Ok(o) => {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty())
                    .collect()
            }
            Err(_) => vec![],
        }
    }
}

fn compute_rms(buf: &[u8]) -> f32 {
    if buf.len() < 2 {
        return 0.0;
    }
    let samples = buf.len() / 2;
    let mut sum_sq: f64 = 0.0;
    for i in (0..buf.len() - 1).step_by(2) {
        let sample = i16::from_le_bytes([buf[i], buf[i + 1]]) as f64;
        sum_sq += sample * sample;
    }
    let rms = (sum_sq / samples as f64).sqrt() / 32768.0;
    (rms * 3.0).min(1.0) as f32
}

extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

mod libc {
    pub const SIGTERM: i32 = 15;
    pub const SIGKILL: i32 = 9;
    pub unsafe fn kill(pid: i32, sig: i32) -> i32 {
        super::kill(pid, sig)
    }
}
