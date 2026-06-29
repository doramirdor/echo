mod app_state;
mod settings;
mod audio;
mod transcription;
mod refinement;
mod context;
mod insertion;
mod memory;
mod voice;
mod templates;
mod history;
mod codebase;
mod providers;
mod fn_monitor;
mod updater;
mod utils;

use app_state::{AppState, EchoState};
use settings::SettingsStore;
use memory::store::MemoryStore;
use templates::store::TemplateStore;
use history::run_log::RunLog;
use audio::recorder::AudioRecorder;
use transcription::live::{LiveTranscriber, LiveEvent};
use fn_monitor::FnAction;

use std::sync::Arc;
use tauri::{
    AppHandle, Emitter, Manager,
    tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState},
    menu::{Menu, MenuItem, PredefinedMenuItem},
    image::Image,
    WebviewWindowBuilder, WebviewUrl,
};
use tokio::sync::{Mutex, mpsc};

// Shared state types for Tauri
struct EchoApp {
    app_state: AppState,
    settings: SettingsStore,
    memory: MemoryStore,
    templates: TemplateStore,
    run_log: RunLog,
    recorder: Arc<Mutex<AudioRecorder>>,
    live_transcriber: Arc<Mutex<LiveTranscriber>>,
    /// Input Monitoring permission as reported by the fn-monitor helper.
    im_status: Arc<Mutex<String>>,
}

/// Take the first `max` characters of `s` without splitting a UTF-8 codepoint.
fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

// ── IPC Commands ──────────────────────────────────────────────────────────────

#[tauri::command]
async fn get_settings(state: tauri::State<'_, EchoApp>) -> Result<serde_json::Value, String> {
    Ok(serde_json::to_value(state.settings.get_all()).unwrap_or_default())
}

#[tauri::command]
async fn set_setting(app: AppHandle, state: tauri::State<'_, EchoApp>, key: String, value: serde_json::Value) -> Result<(), String> {
    state.settings.set_value(&key, value.clone());

    // Keep the OS login item in sync when the toggle changes.
    if key == "openAtLogin" {
        use tauri_plugin_autostart::ManagerExt;
        let mgr = app.autolaunch();
        if value.as_bool().unwrap_or(false) {
            let _ = mgr.enable();
        } else {
            let _ = mgr.disable();
        }
    }
    Ok(())
}

#[tauri::command]
async fn get_memory(state: tauri::State<'_, EchoApp>) -> Result<serde_json::Value, String> {
    Ok(serde_json::to_value(state.memory.get_all()).unwrap_or_default())
}

#[tauri::command]
async fn add_memory(state: tauri::State<'_, EchoApp>, term: String, context: String, misrecognitions: Vec<String>, category: String) -> Result<serde_json::Value, String> {
    let entry = state.memory.add(term, context, misrecognitions, category);
    Ok(serde_json::to_value(entry).unwrap_or_default())
}

#[tauri::command]
async fn remove_memory(state: tauri::State<'_, EchoApp>, id: String) -> Result<bool, String> {
    Ok(state.memory.remove(&id))
}

#[tauri::command]
async fn get_status(state: tauri::State<'_, EchoApp>) -> Result<serde_json::Value, String> {
    let current_state = state.app_state.get_state().await;
    let model_name = state.settings.get(|s| s.whisper_model_name.clone());
    let (whisper_bin, whisper_model) = transcription::whisper::is_ready(&model_name);
    let (sox_ok, sox_msg) = AudioRecorder::check_dependencies();
    let (ax_ok, ax_msg) = insertion::text_inserter::check_permissions();

    // Input Monitoring is reported by the fn-monitor helper itself (it tries to
    // tap the fn key and tells us whether the OS allowed it).
    let im = state.im_status.lock().await.clone();
    let im_ok = im == "granted";

    Ok(serde_json::json!({
        "state": current_state.to_string(),
        "whisper": { "binary": whisper_bin, "model": whisper_model },
        "sox": { "ok": sox_ok, "message": sox_msg },
        "accessibility": { "ok": ax_ok, "message": ax_msg },
        // Microphone TCC status isn't queried natively yet — report "unknown" so
        // the settings UI shows an "Open" shortcut rather than a misleading state.
        "microphone": { "ok": false, "status": "unknown" },
        "inputMonitoring": { "ok": im_ok, "status": im },
    }))
}

#[tauri::command]
async fn toggle(app: AppHandle, state: tauri::State<'_, EchoApp>) -> Result<(), String> {
    handle_toggle(&app, &state).await;
    Ok(())
}

#[tauri::command]
async fn cancel_recording(app: AppHandle, state: tauri::State<'_, EchoApp>) -> Result<(), String> {
    if state.app_state.is_recording().await {
        state.recorder.lock().await.force_stop();
        state.live_transcriber.lock().await.force_stop();
        state.app_state.set_state(EchoState::Idle, None).await;
        let _ = app.emit("state-change", ("idle", serde_json::json!({})));
    }
    Ok(())
}

#[tauri::command]
async fn open_settings_window(app: AppHandle) -> Result<(), String> {
    show_settings(&app);
    Ok(())
}

#[tauri::command]
async fn toggle_overlay_cmd(app: AppHandle) -> Result<(), String> {
    toggle_overlay_window(&app);
    Ok(())
}

#[tauri::command]
async fn reinsert_text(state: tauri::State<'_, EchoApp>, text: String) -> Result<(), String> {
    let source_app = state.app_state.inner.lock().await.source_app.clone();
    insertion::text_inserter::insert(&text, source_app.as_deref()).await
}

#[tauri::command]
async fn scan_project(project_path: String, project_name: String) -> Result<serde_json::Value, String> {
    match codebase::analyzer::analyze(&project_path, &project_name, |_| {}).await {
        Ok(ctx) => Ok(serde_json::json!({ "success": true, "length": ctx.len() })),
        Err(e) => Ok(serde_json::json!({ "success": false, "error": e })),
    }
}

#[tauri::command]
fn open_accessibility_settings() -> Result<(), String> {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn();
    Ok(())
}

#[tauri::command]
fn open_input_monitoring_settings() -> Result<(), String> {
    let opened = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
        .spawn();
    if opened.is_err() {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security")
            .spawn();
    }
    Ok(())
}

#[tauri::command]
fn open_microphone_settings() -> Result<(), String> {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        .spawn();
    Ok(())
}

#[tauri::command]
async fn complete_onboarding(state: tauri::State<'_, EchoApp>, app: AppHandle) -> Result<(), String> {
    state.settings.set_value("onboardingComplete", serde_json::Value::Bool(true));
    if let Some(win) = app.get_webview_window("onboarding") {
        let _ = win.close();
    }
    Ok(())
}

#[tauri::command]
async fn download_whisper_model(app: AppHandle, model_name: Option<String>, state: tauri::State<'_, EchoApp>) -> Result<serde_json::Value, String> {
    let name = model_name.unwrap_or_else(|| state.settings.get(|s| s.whisper_model_name.clone()));
    let app2 = app.clone();
    match transcription::whisper::download_model(&name, move |percent| {
        let _ = app2.emit("download-progress", percent);
    }).await {
        Ok(()) => Ok(serde_json::json!({ "success": true })),
        Err(e) => Ok(serde_json::json!({ "success": false, "error": e })),
    }
}

#[tauri::command]
async fn build_whisper_binary(app: AppHandle) -> Result<serde_json::Value, String> {
    let app2 = app.clone();
    match transcription::whisper::build_binary(move |msg| {
        log::info!("[build] {}", msg);
        let _ = app2.emit("build-progress", msg);
    }).await {
        Ok(()) => Ok(serde_json::json!({ "success": true })),
        Err(e) => Ok(serde_json::json!({ "success": false, "error": e })),
    }
}

#[tauri::command]
async fn check_whisper_binary(model_name: Option<String>, state: tauri::State<'_, EchoApp>) -> Result<serde_json::Value, String> {
    let name = model_name.unwrap_or_else(|| state.settings.get(|s| s.whisper_model_name.clone()));
    let (binary, model) = transcription::whisper::is_ready(&name);
    Ok(serde_json::json!({ "binary": binary, "model": model }))
}

#[tauri::command]
fn list_whisper_models() -> Result<serde_json::Value, String> {
    let downloaded = transcription::whisper::list_downloaded_models();
    let models: Vec<serde_json::Value> = transcription::whisper::WHISPER_MODELS.iter().map(|m| {
        serde_json::json!({
            "name": m.name,
            "label": m.label,
            "size": m.size,
            "downloaded": downloaded.contains(&m.name.to_string()),
        })
    }).collect();
    Ok(serde_json::to_value(models).unwrap_or_default())
}

#[tauri::command]
fn check_cli_exists(command: String) -> Result<bool, String> {
    Ok(std::process::Command::new("which").arg(&command).output().map(|o| o.status.success()).unwrap_or(false))
}

#[tauri::command]
fn list_audio_devices() -> Result<Vec<String>, String> {
    Ok(AudioRecorder::list_input_devices())
}

#[tauri::command]
fn check_prompt_staleness(state: tauri::State<'_, EchoApp>) -> Result<serde_json::Value, String> {
    let custom_prompt = state.settings.get(|s| s.custom_prompt.clone());
    let custom_date = state.settings.get(|s| s.custom_prompt_date.clone());
    if custom_prompt.is_empty() {
        return Ok(serde_json::json!({ "stale": false }));
    }
    if custom_date.is_empty() {
        return Ok(serde_json::json!({ "stale": true, "defaultVersion": refinement::refiner::DEFAULT_PROMPT_VERSION }));
    }
    Ok(serde_json::json!({
        "stale": custom_date.as_str() < refinement::refiner::DEFAULT_PROMPT_VERSION,
        "defaultVersion": refinement::refiner::DEFAULT_PROMPT_VERSION,
        "customDate": custom_date,
    }))
}

#[tauri::command]
async fn get_run_log(state: tauri::State<'_, EchoApp>) -> Result<serde_json::Value, String> {
    Ok(serde_json::to_value(state.run_log.get_all()).unwrap_or_default())
}

#[tauri::command]
async fn clear_run_log(state: tauri::State<'_, EchoApp>) -> Result<(), String> {
    state.run_log.clear();
    Ok(())
}

#[tauri::command]
async fn search_run_log(state: tauri::State<'_, EchoApp>, query: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::to_value(state.run_log.search(&query)).unwrap_or_default())
}

#[tauri::command]
async fn validate_groq_key(api_key: String) -> Result<serde_json::Value, String> {
    let (valid, err) = transcription::groq::validate_api_key(&api_key).await;
    Ok(serde_json::json!({ "valid": valid, "error": err }))
}

#[tauri::command]
async fn validate_deepgram_key(api_key: String) -> Result<serde_json::Value, String> {
    let (valid, err) = transcription::deepgram::validate_api_key(&api_key).await;
    Ok(serde_json::json!({ "valid": valid, "error": err }))
}

#[tauri::command]
async fn validate_openai_key(api_key: String) -> Result<serde_json::Value, String> {
    let (valid, err) = transcription::openai_whisper::validate_api_key(&api_key).await;
    Ok(serde_json::json!({ "valid": valid, "error": err }))
}

#[tauri::command]
async fn check_providers(state: tauri::State<'_, EchoApp>) -> Result<serde_json::Value, String> {
    let results = providers::health::check_all_providers(&state.settings).await;
    Ok(serde_json::to_value(results).unwrap_or_default())
}

#[tauri::command]
fn get_logs() -> Result<String, String> {
    Ok(utils::logger::read_recent_logs(50000))
}

#[tauri::command]
fn copy_logs() -> Result<serde_json::Value, String> {
    let logs = utils::logger::read_recent_logs(50000);
    let len = logs.len();
    if let Ok(mut cb) = arboard::Clipboard::new() {
        let _ = cb.set_text(&logs);
    }
    Ok(serde_json::json!({ "success": true, "length": len }))
}

#[tauri::command]
async fn get_templates(state: tauri::State<'_, EchoApp>) -> Result<serde_json::Value, String> {
    Ok(serde_json::to_value(state.templates.get_all()).unwrap_or_default())
}

#[tauri::command]
async fn add_template(state: tauri::State<'_, EchoApp>, name: String, trigger: String, content: String) -> Result<serde_json::Value, String> {
    let t = state.templates.add(name, trigger, content);
    Ok(serde_json::to_value(t).unwrap_or_default())
}

#[tauri::command]
async fn remove_template(state: tauri::State<'_, EchoApp>, id: String) -> Result<bool, String> {
    Ok(state.templates.remove(&id))
}

#[tauri::command]
async fn get_stats(state: tauri::State<'_, EchoApp>) -> Result<serde_json::Value, String> {
    let entries = state.run_log.get_all();
    let total = entries.len();
    let total_words: usize = entries.iter()
        .map(|e| e.refined_text.split_whitespace().count())
        .sum();
    let avg_duration: f64 = if total > 0 {
        entries.iter().map(|e| e.duration_ms as f64).sum::<f64>() / total as f64
    } else { 0.0 };
    Ok(serde_json::json!({
        "totalRecordings": total,
        "totalWords": total_words,
        "averageDuration": avg_duration,
    }))
}

#[tauri::command]
async fn resize_overlay(app: AppHandle, expanded: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("overlay") {
        let size = if expanded {
            tauri::LogicalSize::new(400.0, 120.0)
        } else {
            tauri::LogicalSize::new(180.0, 36.0)
        };
        let _ = win.set_size(tauri::Size::Logical(size));
    }
    Ok(())
}

#[tauri::command]
async fn get_project_context() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "hasContext": codebase::analyzer::has_context(),
        "context": codebase::analyzer::load_context(),
        "path": codebase::analyzer::get_context_path(),
    }))
}

#[tauri::command]
async fn reinsert_from_history(state: tauri::State<'_, EchoApp>, text: String) -> Result<(), String> {
    let source_app = state.app_state.inner.lock().await.source_app.clone();
    insertion::text_inserter::insert(&text, source_app.as_deref()).await
}

// ── Recording control ─────────────────────────────────────────────────────────

/// Reset the per-recording trigger flags.
async fn clear_hold_flags(echo: &EchoApp) {
    let mut inner = echo.app_state.inner.lock().await;
    inner.fn_hold_recording = false;
    inner.hotkey_hold_recording = false;
}

/// Plain toggle used by the tray menu and the renderer's overlay button — there's
/// no key to "release", so it always flips between idle and recording.
async fn handle_toggle(app: &AppHandle, echo: &EchoApp) {
    match echo.app_state.get_state().await {
        EchoState::Recording => stop_recording(app, echo).await,
        EchoState::Idle | EchoState::Error => {
            clear_hold_flags(echo).await;
            begin_recording_with_delay(app, echo).await;
        }
        _ => {}
    }
}

/// The fallback global-shortcut was pressed. In hold mode this starts recording
/// (the release stops it); in toggle mode it flips state.
async fn handle_hotkey_pressed(app: &AppHandle, echo: &EchoApp) {
    let mode = echo.settings.get(|s| s.recording_mode.clone());
    let state = echo.app_state.get_state().await;

    if mode == "hold" {
        if matches!(state, EchoState::Idle | EchoState::Error) {
            {
                let mut inner = echo.app_state.inner.lock().await;
                inner.fn_hold_recording = false;
                inner.hotkey_hold_recording = true;
            }
            begin_recording_with_delay(app, echo).await;
        }
        return;
    }

    match state {
        EchoState::Recording => stop_recording(app, echo).await,
        EchoState::Idle | EchoState::Error => {
            clear_hold_flags(echo).await;
            begin_recording_with_delay(app, echo).await;
        }
        _ => {}
    }
}

/// The fallback global-shortcut was released — only meaningful in hold mode.
async fn handle_hotkey_released(app: &AppHandle, echo: &EchoApp) {
    let mode = echo.settings.get(|s| s.recording_mode.clone());
    if !echo.app_state.is_recording().await {
        return;
    }
    let hotkey_hold = echo.app_state.inner.lock().await.hotkey_hold_recording;
    if hotkey_hold || mode == "hold" {
        clear_hold_flags(echo).await;
        stop_recording(app, echo).await;
    }
}

/// High-level fn-key gestures from the Swift monitor.
async fn handle_fn_action(app: &AppHandle, echo: &EchoApp, action: FnAction) {
    let state = echo.app_state.get_state().await;
    match action {
        FnAction::HoldStart => {
            if matches!(state, EchoState::Idle | EchoState::Error) {
                {
                    let mut inner = echo.app_state.inner.lock().await;
                    inner.fn_hold_recording = true;
                    inner.hotkey_hold_recording = false;
                }
                begin_recording_with_delay(app, echo).await;
            }
        }
        FnAction::HoldEnd => {
            let fn_hold = echo.app_state.inner.lock().await.fn_hold_recording;
            if state == EchoState::Recording && fn_hold {
                echo.app_state.inner.lock().await.fn_hold_recording = false;
                stop_recording(app, echo).await;
            }
        }
        FnAction::DoubleClick => match state {
            EchoState::Idle | EchoState::Error => {
                clear_hold_flags(echo).await;
                begin_recording_with_delay(app, echo).await;
            }
            EchoState::Recording => {
                let fn_hold = echo.app_state.inner.lock().await.fn_hold_recording;
                if !fn_hold {
                    stop_recording(app, echo).await;
                }
            }
            _ => {}
        },
        FnAction::SingleClick => {
            // A single fn tap stops toggle-style recording (started via double-click).
            if state == EchoState::Recording {
                let fn_hold = echo.app_state.inner.lock().await.fn_hold_recording;
                if !fn_hold {
                    stop_recording(app, echo).await;
                }
            }
        }
    }
}

async fn begin_recording_with_delay(app: &AppHandle, echo: &EchoApp) {
    let delay = echo.settings.get(|s| s.start_delay);
    if delay > 0 {
        log::info!("[echo] Starting recording in {}ms", delay);
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        // Bail if state changed during the delay (e.g. user cancelled).
        if !matches!(echo.app_state.get_state().await, EchoState::Idle | EchoState::Error) {
            return;
        }
    }
    start_recording(app, echo).await;
}

async fn start_recording(app: &AppHandle, echo: &EchoApp) {
    // Capture source app (frontmost) so we can re-activate it and insert there.
    let source_app = std::process::Command::new("osascript")
        .args(["-e", "tell application \"System Events\" to get name of first application process whose frontmost is true"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

    {
        let mut inner = echo.app_state.inner.lock().await;
        inner.source_app = source_app.clone();
        inner.live_injected_text.clear();
        inner.existing_field_text = None;
        inner.existing_field_text_after = None;
    }

    let device = echo.settings.get(|s| {
        if s.audio_device.is_empty() { None } else { Some(s.audio_device.clone()) }
    });

    let level_rx = {
        let mut recorder = echo.recorder.lock().await;
        if let Err(e) = recorder.start(device.as_deref()) {
            let msg = utils::errors::to_user_facing_error(&e);
            echo.app_state.set_state(EchoState::Error, Some(msg.clone())).await;
            let _ = app.emit("state-change", ("error", serde_json::json!({ "error": msg })));
            return;
        }
        recorder.level_receiver()
    };

    // Mark recording BEFORE spawning the level task so it sees the live state.
    echo.app_state.set_state(EchoState::Recording, None).await;

    // Live transcription: stream partials to the overlay and inject finals into
    // the target app while still recording. The final refined text later replaces
    // what was injected (see run_pipeline → replace_live_text).
    if let Some(mut live_rx) = echo.live_transcriber.lock().await.start() {
        let app_handle = app.clone();
        tokio::spawn(async move {
            while let Some(ev) = live_rx.recv().await {
                let echo = app_handle.state::<EchoApp>();
                match ev {
                    LiveEvent::Partial(text) => {
                        let _ = app_handle.emit("live-transcript", text);
                    }
                    LiveEvent::Final(text) => {
                        let trimmed = text.trim().to_string();
                        if trimmed.is_empty() { continue; }
                        let _ = app_handle.emit("live-transcript", trimmed.clone());
                        if echo.app_state.is_recording().await {
                            let sep = {
                                let inner = echo.app_state.inner.lock().await;
                                if inner.live_injected_text.is_empty() { "" } else { " " }
                            };
                            let chunk = format!("{}{}", sep, trimmed);
                            let _ = insertion::text_inserter::insert_live(&chunk).await;
                            echo.app_state.inner.lock().await.live_injected_text.push_str(&chunk);
                            log::info!("[echo] Live injected: \"{}\"", trimmed);
                        }
                    }
                }
            }
        });
    }

    // Caret context for sentence continuation (best-effort, off the hot path).
    {
        let app_handle = app.clone();
        tokio::spawn(async move {
            if let Ok(fc) = tokio::task::spawn_blocking(context::window::capture_field_context).await {
                let echo = app_handle.state::<EchoApp>();
                let mut inner = echo.app_state.inner.lock().await;
                inner.existing_field_text = if fc.before.is_empty() { None } else { Some(fc.before) };
                inner.existing_field_text_after = if fc.after.is_empty() { None } else { Some(fc.after) };
            }
        });
    }

    // Audio-level metering for the overlay waveform + silence auto-stop.
    spawn_level_task(app, echo, level_rx);

    audio::sounds::play_recording_start();

    // Re-activate the source app so the keystroke lands where the user was.
    if let Some(ref app_name) = source_app {
        let escaped = app_name.replace('\\', "\\\\").replace('"', "\\\"");
        let _ = std::process::Command::new("osascript")
            .args(["-e", &format!("tell application \"{}\" to activate", escaped)])
            .output();
    }

    let _ = app.emit("state-change", ("recording", serde_json::json!({})));
}

/// Forwards audio levels to the overlay and auto-stops on sustained silence.
/// Exits when recording ends so tasks don't accumulate across sessions.
fn spawn_level_task(app: &AppHandle, echo: &EchoApp, mut level_rx: tokio::sync::watch::Receiver<f32>) {
    let app_handle = app.clone();
    let silence_detection = echo.settings.get(|s| s.silence_detection);
    let whisper_mode = echo.settings.get(|s| s.whisper_mode);
    let mut threshold = echo.settings.get(|s| s.silence_threshold);
    if whisper_mode {
        // Quiet speech mustn't be mistaken for silence in whisper mode.
        threshold = threshold.min(0.005);
    }
    let duration_ms = echo.settings.get(|s| s.silence_duration);

    tokio::spawn(async move {
        let mut silence_start: Option<std::time::Instant> = None;
        // Grace period so the silent moment before the first word isn't counted.
        let grace_until = std::time::Instant::now() + std::time::Duration::from_millis(1000);

        while level_rx.changed().await.is_ok() {
            let echo = app_handle.state::<EchoApp>();
            if !echo.app_state.is_recording().await {
                break;
            }

            let level = *level_rx.borrow();
            let _ = app_handle.emit("audio-level", level);

            if silence_detection && std::time::Instant::now() >= grace_until {
                if (level as f64) < threshold {
                    match silence_start {
                        None => silence_start = Some(std::time::Instant::now()),
                        Some(start) => {
                            if start.elapsed().as_millis() as u64 >= duration_ms {
                                log::info!("[echo] Silence detected ({}ms), auto-stopping", duration_ms);
                                clear_hold_flags(&echo).await;
                                stop_recording(&app_handle, &echo).await;
                                break;
                            }
                        }
                    }
                } else {
                    silence_start = None;
                }
            }

            tokio::time::sleep(std::time::Duration::from_millis(33)).await;
        }
    });
}

async fn stop_recording(app: &AppHandle, echo: &EchoApp) {
    audio::sounds::play_recording_stop();
    echo.live_transcriber.lock().await.force_stop();

    let app_handle = app.clone();
    let settings = echo.settings.clone();
    let memory = echo.memory.clone();
    let templates = echo.templates.clone();
    let run_log = echo.run_log.clone();
    let app_state = echo.app_state.clone();
    let recorder = echo.recorder.clone();

    // Run pipeline in background
    tokio::spawn(async move {
        run_pipeline(&app_handle, &settings, &memory, &templates, &run_log, &app_state, &recorder).await;
    });
}

async fn run_pipeline(
    app: &AppHandle,
    settings: &SettingsStore,
    memory: &MemoryStore,
    templates: &TemplateStore,
    run_log: &RunLog,
    app_state: &AppState,
    recorder: &Arc<Mutex<AudioRecorder>>,
) {
    let pipeline_start = std::time::Instant::now();
    let stt_engine = settings.get(|s| s.stt_engine.clone());
    let llm_provider = settings.get(|s| s.llm_provider.clone());
    let live_injected_text;
    let source_app;

    {
        let inner = app_state.inner.lock().await;
        live_injected_text = inner.live_injected_text.clone();
        source_app = inner.source_app.clone();
    }

    let result: Result<(), String> = async {
        app_state.set_state(EchoState::Transcribing, None).await;
        let _ = app.emit("state-change", ("transcribing", serde_json::json!({})));

        let wav_path = recorder.lock().await.stop().await?;
        let noise_reduction = settings.get(|s| s.noise_reduction);
        let whisper_mode = settings.get(|s| s.whisper_mode);
        let clean_path = AudioRecorder::post_process(&wav_path, noise_reduction, whisper_mode);

        log::info!("[pipeline] Transcribing with {}...", stt_engine);

        // Capture window context concurrently with transcription so its latency
        // (osascript/screenshot/LLM synthesis) is hidden behind the STT round trip
        // instead of adding to time-to-first-insertion. Only when an LLM consumes it.
        let context_handle = if llm_provider != "none" && settings.get(|s| s.use_window_context) {
            let provider = settings.get(|s| s.context_provider.clone());
            let capture_shots = settings.get(|s| s.capture_screenshots);
            let claude_key = settings.get(|s| s.claude_api_key.clone());
            let groq_key = settings.get(|s| s.groq_api_key.clone());
            Some(tokio::spawn(async move {
                let wctx = tokio::task::spawn_blocking(context::window::capture_window_context)
                    .await
                    .unwrap_or_default();
                if provider != "none" {
                    // Summarize the active window (and optionally a screenshot) via an LLM.
                    let screenshot = if capture_shots {
                        tokio::task::spawn_blocking(context::window::capture_screenshot)
                            .await
                            .ok()
                            .flatten()
                    } else {
                        None
                    };
                    let api_key = if provider == "claude" { claude_key } else { groq_key };
                    let synthesized = context::synthesizer::synthesize_context(
                        &wctx, screenshot.as_deref(), &provider, &api_key,
                    )
                    .await
                    .unwrap_or_default();
                    if let Some(path) = screenshot {
                        context::window::cleanup_screenshot(&path);
                    }
                    synthesized
                } else {
                    context::window::format_window_context(&wctx)
                }
            }))
        } else {
            None
        };

        // Bias recognition toward known vocabulary, learned corrections, and
        // project jargon — fixes terms *during* transcription, before the LLM runs.
        let bias_prompt = transcription::speech_bias::build_speech_bias_prompt(
            &settings.get(|s| s.vocabulary_list.clone()),
            &memory.get_all(),
            codebase::analyzer::load_context().as_deref(),
        );

        let result = transcription::transcribe_audio(&stt_engine, &clean_path, &wav_path, settings, &bias_prompt).await?;

        // Surface low-confidence segments (Deepgram/OpenAI) to the overlay.
        let low_conf: Vec<_> = result.segments.iter().filter(|s| s.confidence < 0.7).cloned().collect();
        if !low_conf.is_empty() {
            let _ = app.emit("confidence-segments", &low_conf);
        }

        let raw_text = result.text;
        log::info!("[pipeline] RAW: \"{}\"", raw_text);

        let mut cleaned = regex::Regex::new(r"\[.*?\]").unwrap()
            .replace_all(&raw_text, "").trim().to_string();

        // Template match
        if let Some(template) = templates.match_trigger(&cleaned) {
            log::info!("[pipeline] Template matched: {}", template.name);
            cleaned = template.content;
        }

        // Voice commands
        let voice_result = voice::commands::process_voice_commands(&cleaned, settings.get(|s| s.voice_commands_enabled));
        cleaned = voice_result.text;

        if cleaned.is_empty() {
            log::info!("[pipeline] Empty transcription, skipping");
            app_state.set_state(EchoState::Idle, None).await;
            let _ = app.emit("state-change", ("idle", serde_json::json!({})));
            return Ok(());
        }

        // Refine
        let mut refined_text = cleaned.clone();

        // What is currently shown in the target app and will be replaced by the
        // refined text. Starts as whatever was injected live during recording.
        let mut injected_text = live_injected_text.clone();
        // Continuation join only applies when NOT replacing live text — the live
        // path already handled spacing/capitalization while recording.
        let continuation_before = if injected_text.is_empty() {
            app_state.inner.lock().await.existing_field_text.clone().unwrap_or_default()
        } else {
            String::new()
        };

        if !voice_result.skip_refinement && llm_provider != "none" {
            app_state.set_state(EchoState::Refining, None).await;
            let _ = app.emit("state-change", ("refining", serde_json::json!({})));

            // Instant feedback (Wispr-style): if nothing has been injected yet (live
            // transcription was off or silent), insert the raw transcript now and
            // swap in the refined version once it lands.
            if injected_text.is_empty() {
                let early = if continuation_before.is_empty() {
                    cleaned.clone()
                } else {
                    insertion::continuation::join_continuation(&continuation_before, &cleaned)
                };
                if insertion::text_inserter::insert_live(&early).await.is_ok() {
                    injected_text = early;
                }
            }

            let relevant = memory.find_relevant(&cleaned);
            let formatted = memory.format_for_prompt(&relevant);

            // Await the context captured in parallel with transcription above.
            let mut window_context_str = match context_handle {
                Some(handle) => handle.await.unwrap_or_default(),
                None => String::new(),
            };

            let history_ctx = context::dictation::build_dictation_context(run_log, settings.get(|s| s.dictation_history_context));
            if !history_ctx.is_empty() {
                if !window_context_str.is_empty() {
                    window_context_str.push_str(&format!("\n\nRecent dictations:\n{}", history_ctx));
                } else {
                    window_context_str = format!("Recent dictations:\n{}", history_ctx);
                }
            }

            // Per-app profile prompt — passed separately so it AUGMENTS the base
            // rules instead of replacing them (a user custom prompt still replaces).
            let profile_prompt = context::app_profiles::get_profile_prompt(
                source_app.as_deref(),
                &settings.get(|s| s.app_profiles.clone()),
            );
            let custom_prompt = settings.get(|s| s.custom_prompt.clone());

            let (field_before, field_after) = {
                let inner = app_state.inner.lock().await;
                (inner.existing_field_text.clone(), inner.existing_field_text_after.clone())
            };

            // Content-aware auto-formatting: only for a fresh field (not a
            // mid-sentence continuation) and only when the user hasn't disabled it.
            let content_type = if settings.get(|s| s.auto_format_content)
                && field_before.as_deref().map_or(true, |s| s.is_empty())
            {
                match refinement::refiner::detect_content_type(&cleaned) {
                    "default" => None,
                    ct => Some(ct.to_string()),
                }
            } else {
                None
            };

            let ctx = refinement::RefinementContext {
                memory_entries: relevant.clone(),
                memory_formatted: formatted,
                window_context: Some(window_context_str),
                vocabulary_list: Some(settings.get(|s| s.vocabulary_list.clone())),
                custom_prompt: Some(custom_prompt),
                app_profile_prompt: if profile_prompt.is_empty() { None } else { Some(profile_prompt) },
                existing_field_text: field_before,
                existing_field_text_after: field_after,
                tone: Some(settings.get(|s| s.tone.clone())),
                content_type,
            };

            match refinement::refine(&llm_provider, &cleaned, &ctx, settings).await {
                Ok(text) => {
                    refined_text = refinement::refiner::sanitize_refined_output(&text);
                    if refined_text == "EMPTY" || refined_text.is_empty() {
                        log::info!("[pipeline] LLM returned EMPTY");
                        // Remove anything we optimistically injected for instant feedback.
                        if !injected_text.is_empty() {
                            let _ = insertion::text_inserter::replace_live_text(
                                "", injected_text.chars().count(), source_app.as_deref(),
                            ).await;
                        }
                        app_state.set_state(EchoState::Idle, None).await;
                        let _ = app.emit("state-change", ("idle", serde_json::json!({})));
                        return Ok(());
                    }
                    memory.mark_used(&relevant.iter().map(|e| e.id.clone()).collect::<Vec<_>>());
                }
                Err(e) => {
                    log::warn!("[pipeline] Refinement failed, using raw: {}", e);
                    refined_text = cleaned.clone();
                }
            }

            // Optional second pass: a dedicated grammar/punctuation validator.
            // Only run when refinement actually changed the text (off by default
            // for speed, but on in defaults here to match the Electron pipeline).
            if settings.get(|s| s.grammar_check) && refined_text != cleaned {
                let grammar_ctx = refinement::RefinementContext {
                    memory_entries: vec![],
                    memory_formatted: String::new(),
                    window_context: None,
                    vocabulary_list: None,
                    custom_prompt: Some(refinement::refiner::GRAMMAR_VALIDATION_PROMPT.to_string()),
                    app_profile_prompt: None,
                    existing_field_text: None,
                    existing_field_text_after: None,
                    tone: None,
                    content_type: None,
                };
                match refinement::refine(&llm_provider, &refined_text, &grammar_ctx, settings).await {
                    Ok(g) => {
                        let g = refinement::refiner::sanitize_refined_output(&g);
                        if !g.is_empty() && g != "EMPTY" {
                            refined_text = g;
                        }
                    }
                    Err(e) => log::warn!("[pipeline] Grammar validation failed: {}", e),
                }
            }
        }

        app_state.set_transcription(raw_text.clone(), refined_text.clone()).await;

        app_state.set_state(EchoState::Inserting, None).await;

        if !injected_text.is_empty() {
            // Replace the text already on screen (live or instant-insert) with the
            // refined version. Skip the round trip if it would be a no-op.
            let final_text = if continuation_before.is_empty() {
                refined_text.clone()
            } else {
                insertion::continuation::join_continuation(&continuation_before, &refined_text)
            };
            if final_text != injected_text {
                let live_chars = injected_text.chars().count();
                log::info!("[pipeline] Inserting (replace {} chars): \"{}\"", live_chars, final_text);
                insertion::text_inserter::replace_live_text(&final_text, live_chars, source_app.as_deref()).await?;
            } else {
                log::info!("[pipeline] Refined text matches what is already inserted — leaving as-is");
            }
        } else {
            // Nothing on screen yet (no LLM and no live text): fresh insert,
            // continuing from the caret. Deterministic, works with no LLM.
            let before = app_state.inner.lock().await.existing_field_text.clone().unwrap_or_default();
            let text_to_insert = if before.is_empty() {
                refined_text.clone()
            } else {
                insertion::continuation::join_continuation(&before, &refined_text)
            };
            log::info!("[pipeline] Inserting: \"{}\"", text_to_insert);
            insertion::text_inserter::insert(&text_to_insert, source_app.as_deref()).await?;
        }

        log::info!("[pipeline] Done");
        app_state.set_state(EchoState::Idle, None).await;

        let _ = app.emit("state-change", ("idle", serde_json::json!({
            "lastResult": truncate_chars(&refined_text, 60),
            "rawResult": raw_text,
        })));

        // Log run
        run_log.add(raw_text, refined_text.clone(), String::new(), stt_engine.clone(), llm_provider.clone(), pipeline_start.elapsed().as_millis() as u64, None);

        // Vocabulary learning
        memory::vocabulary::analyze_and_learn(memory, &cleaned, &refined_text);

        // Notification (native, via the notification plugin).
        let body = if refined_text.chars().count() > 80 {
            format!("{}...", truncate_chars(&refined_text, 80))
        } else {
            refined_text.clone()
        };
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title("Echo").body(&body).show();

        Ok(())
    }.await;

    if let Err(e) = result {
        let msg = utils::errors::to_user_facing_error(&e);
        log::error!("[pipeline] ERROR: {}", msg);
        app_state.set_state(EchoState::Error, Some(msg.clone())).await;
        let _ = app.emit("state-change", ("error", serde_json::json!({ "error": msg })));

        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder()
            .title("Echo — Error")
            .body(truncate_chars(&msg, 100))
            .show();

        run_log.add(String::new(), String::new(), String::new(), stt_engine, llm_provider, pipeline_start.elapsed().as_millis() as u64, Some(msg));

        let state = app_state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            if state.get_state().await == EchoState::Error {
                state.set_state(EchoState::Idle, None).await;
            }
        });
    }
}

// ── Window helpers ────────────────────────────────────────────────────────────

fn show_settings(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .title("Echo Settings")
        .inner_size(720.0, 800.0)
        .build();
}

fn show_onboarding(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("onboarding") {
        let _ = win.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "onboarding", WebviewUrl::App("onboarding.html".into()))
        .title("Welcome to Echo")
        .inner_size(520.0, 680.0)
        .resizable(false)
        .build();
}

fn create_overlay(app: &AppHandle) {
    let _ = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("")
        .inner_size(340.0, 160.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .focused(false)
        // Start hidden — the state watcher shows it when recording begins and
        // hides it again shortly after returning to idle.
        .visible(false)
        .visible_on_all_workspaces(true)
        .build();
}

fn toggle_overlay_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("overlay") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
        }
    }
}

// ── App Entry Point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // File-backed logger so the in-app log viewer has content (also prints to stderr).
    utils::logger::init();

    let echo = EchoApp {
        app_state: AppState::new(),
        settings: SettingsStore::new(),
        memory: MemoryStore::new(),
        templates: TemplateStore::new(),
        run_log: RunLog::new(),
        recorder: Arc::new(Mutex::new(AudioRecorder::new())),
        live_transcriber: Arc::new(Mutex::new(LiveTranscriber::new())),
        im_status: Arc::new(Mutex::new("unknown".to_string())),
    };

    // Pre-compile Swift binaries (best-effort; recompiled on demand if stale).
    utils::swift_binary::ensure_swift_binary("fn-monitor", "scripts/fn-monitor.swift");
    utils::swift_binary::ensure_swift_binary("live-transcribe", "scripts/live-transcribe.swift");
    utils::swift_binary::ensure_swift_binary("transcribe", "scripts/transcribe.swift");
    utils::swift_binary::ensure_swift_binary("field-context", "scripts/field-context.swift");

    let show_onboarding_on_start: bool = !echo.settings.get(|s| s.onboarding_complete);

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(echo)
        .invoke_handler(tauri::generate_handler![
            get_settings, set_setting,
            get_memory, add_memory, remove_memory,
            get_status, toggle, cancel_recording,
            open_settings_window, toggle_overlay_cmd,
            reinsert_text, resize_overlay, get_stats,
            scan_project, open_accessibility_settings,
            open_input_monitoring_settings, open_microphone_settings,
            complete_onboarding,
            download_whisper_model, build_whisper_binary,
            check_whisper_binary, list_whisper_models,
            check_cli_exists, list_audio_devices,
            check_prompt_staleness,
            get_run_log, clear_run_log, search_run_log,
            validate_groq_key, validate_deepgram_key, validate_openai_key,
            check_providers, get_logs, copy_logs,
            get_templates, add_template, remove_template,
            get_project_context, reinsert_from_history,
        ])
        .setup(move |app| {
            // Hide from dock (menu bar app)
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Create tray
            let quit = MenuItem::with_id(app, "quit", "Quit Echo", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
            let toggle_item = MenuItem::with_id(app, "toggle", "Start Recording", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;

            let menu = Menu::with_items(app, &[&toggle_item, &sep, &settings_item, &sep, &quit])?;

            let icon_path = app.path().resolve("icons/tray-icon.png", tauri::path::BaseDirectory::Resource)
                .unwrap_or_else(|_| std::path::PathBuf::from("icons/tray-icon.png"));

            let icon = if icon_path.exists() {
                Image::from_path(&icon_path).unwrap_or_else(|_| Image::from_bytes(include_bytes!("../icons/tray-icon.png")).unwrap())
            } else {
                Image::from_bytes(include_bytes!("../icons/tray-icon.png")).unwrap()
            };

            let _tray = TrayIconBuilder::with_id("main")
                .icon(icon)
                .icon_as_template(true)
                .menu(&menu)
                // Show the menu on right-click only; left-click opens Settings (below).
                .show_menu_on_left_click(false)
                .tooltip("Echo — Voice to Text")
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        show_settings(tray.app_handle());
                    }
                })
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "quit" => { app.exit(0); }
                        "settings" => { show_settings(app); }
                        "toggle" => {
                            let app = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let state = app.state::<EchoApp>();
                                handle_toggle(&app, &state).await;
                            });
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Create overlay
            create_overlay(app.handle());

            // ── fn-key monitor (primary trigger): hold / double-click / single-click ──
            {
                let (tx, mut rx) = mpsc::unbounded_channel::<FnAction>();
                let im_status = app.state::<EchoApp>().im_status.clone();
                fn_monitor::start(tx, im_status);
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    while let Some(action) = rx.recv().await {
                        let echo = app_handle.state::<EchoApp>();
                        handle_fn_action(&app_handle, &echo, action).await;
                    }
                });
                log::info!("[echo] fn key monitor started");
            }

            // ── Fallback global hotkeys ──
            use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

            let hotkey = app.state::<EchoApp>().settings.get(|s| s.hotkey.clone());
            let hotkey_str = hotkey.replace("CommandOrControl", "CmdOrCtrl");
            let app_handle = app.handle().clone();
            if let Err(e) = app.global_shortcut().on_shortcut(hotkey_str.as_str(), move |_app, _shortcut, event| {
                // Pressed/Released both fire here — hold mode stops on release.
                let pressed = event.state == ShortcutState::Pressed;
                let app = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<EchoApp>();
                    if pressed {
                        handle_hotkey_pressed(&app, &state).await;
                    } else {
                        handle_hotkey_released(&app, &state).await;
                    }
                });
            }) {
                log::error!("[echo] Failed to register hotkey {}: {}", hotkey_str, e);
            } else {
                log::info!("[echo] Fallback hotkey registered: {}", hotkey_str);
            }

            // Overlay toggle hotkey.
            let overlay_hotkey = app.state::<EchoApp>().settings.get(|s| s.overlay_hotkey.clone());
            let overlay_hotkey_str = overlay_hotkey.replace("CommandOrControl", "CmdOrCtrl");
            let app_handle2 = app.handle().clone();
            if let Err(e) = app.global_shortcut().on_shortcut(overlay_hotkey_str.as_str(), move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    toggle_overlay_window(&app_handle2);
                }
            }) {
                log::error!("[echo] Failed to register overlay hotkey {}: {}", overlay_hotkey_str, e);
            } else {
                log::info!("[echo] Overlay hotkey registered: {}", overlay_hotkey_str);
            }

            // ── State watcher: drive tray label + overlay visibility from state ──
            {
                let app_handle = app.handle().clone();
                let mut rx = app.state::<EchoApp>().app_state.state_rx.clone();
                let toggle_item = toggle_item.clone();
                tauri::async_runtime::spawn(async move {
                    while rx.changed().await.is_ok() {
                        let (state, _err) = rx.borrow().clone();

                        if let Some(tray) = app_handle.tray_by_id("main") {
                            if state == EchoState::Recording {
                                let _ = tray.set_tooltip(Some("Echo — Recording…"));
                                let _ = toggle_item.set_text("Stop Recording");
                            } else {
                                let _ = tray.set_tooltip(Some("Echo — Voice to Text"));
                                let _ = toggle_item.set_text("Start Recording");
                            }
                        }

                        if let Some(win) = app_handle.get_webview_window("overlay") {
                            match state {
                                EchoState::Idle => {
                                    // Linger briefly to show the result, then hide if still idle.
                                    let w = win.clone();
                                    let ah = app_handle.clone();
                                    tauri::async_runtime::spawn(async move {
                                        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                                        if ah.state::<EchoApp>().app_state.get_state().await == EchoState::Idle {
                                            let _ = w.hide();
                                        }
                                    });
                                }
                                EchoState::Error => {
                                    audio::sounds::play_error();
                                    let _ = win.show();
                                    let w = win.clone();
                                    let ah = app_handle.clone();
                                    tauri::async_runtime::spawn(async move {
                                        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
                                        if ah.state::<EchoApp>().app_state.get_state().await == EchoState::Idle {
                                            let _ = w.hide();
                                        }
                                    });
                                }
                                _ => {
                                    let _ = win.show();
                                }
                            }
                        }
                    }
                });
            }

            // ── Sync the OS login item with the saved preference ──
            {
                use tauri_plugin_autostart::ManagerExt;
                let want = app.state::<EchoApp>().settings.get(|s| s.open_at_login);
                let mgr = app.autolaunch();
                let enabled = mgr.is_enabled().unwrap_or(false);
                if want && !enabled {
                    let _ = mgr.enable();
                } else if !want && enabled {
                    let _ = mgr.disable();
                }
            }

            // ── Auto-updater (packaged builds only; mirrors src/main/updater.ts) ──
            {
                let auto_update = app.state::<EchoApp>().settings.get(|s| s.auto_update_enabled);
                updater::setup_auto_updater(app.handle().clone(), auto_update);
            }

            // Show onboarding if needed
            if show_onboarding_on_start {
                show_onboarding(app.handle());
            }

            log::info!("[echo] Ready!");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
