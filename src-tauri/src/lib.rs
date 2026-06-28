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
mod utils;

use app_state::{AppState, EchoState};
use settings::SettingsStore;
use memory::store::MemoryStore;
use templates::store::TemplateStore;
use history::run_log::RunLog;
use audio::recorder::AudioRecorder;
use transcription::live::LiveTranscriber;

use std::sync::Arc;
use tauri::{
    AppHandle, Emitter, Manager,
    tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState},
    menu::{Menu, MenuItem, PredefinedMenuItem},
    image::Image,
    WebviewWindowBuilder, WebviewUrl,
};
use tokio::sync::Mutex;

// Shared state types for Tauri
struct EchoApp {
    app_state: AppState,
    settings: SettingsStore,
    memory: MemoryStore,
    templates: TemplateStore,
    run_log: RunLog,
    recorder: Arc<Mutex<AudioRecorder>>,
    live_transcriber: Arc<Mutex<LiveTranscriber>>,
}

// ── IPC Commands ──────────────────────────────────────────────────────────────

#[tauri::command]
async fn get_settings(state: tauri::State<'_, EchoApp>) -> Result<serde_json::Value, String> {
    Ok(serde_json::to_value(state.settings.get_all()).unwrap_or_default())
}

#[tauri::command]
async fn set_setting(state: tauri::State<'_, EchoApp>, key: String, value: serde_json::Value) -> Result<(), String> {
    state.settings.set_value(&key, value);
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

    Ok(serde_json::json!({
        "state": current_state.to_string(),
        "whisper": { "binary": whisper_bin, "model": whisper_model },
        "sox": { "ok": sox_ok, "message": sox_msg },
        "accessibility": { "ok": ax_ok, "message": ax_msg },
        // Microphone / Input Monitoring TCC status isn't queried natively on the Tauri
        // side yet — report "unknown" so the settings UI shows an "Open" shortcut to the
        // right pane rather than a misleading "granted/denied".
        "microphone": { "ok": false, "status": "unknown" },
        "inputMonitoring": { "ok": false, "status": "unknown" },
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
async fn download_whisper_model(model_name: Option<String>, state: tauri::State<'_, EchoApp>) -> Result<serde_json::Value, String> {
    let name = model_name.unwrap_or_else(|| state.settings.get(|s| s.whisper_model_name.clone()));
    match transcription::whisper::download_model(&name, |_percent| {}).await {
        Ok(()) => Ok(serde_json::json!({ "success": true })),
        Err(e) => Ok(serde_json::json!({ "success": false, "error": e })),
    }
}

#[tauri::command]
async fn build_whisper_binary() -> Result<serde_json::Value, String> {
    match transcription::whisper::build_binary(|msg| { log::info!("[build] {}", msg); }).await {
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

// ── Core Logic ────────────────────────────────────────────────────────────────

async fn handle_toggle(app: &AppHandle, echo: &EchoApp) {
    let current = echo.app_state.get_state().await;
    match current {
        EchoState::Recording => {
            stop_recording(app, echo).await;
        }
        EchoState::Idle | EchoState::Error => {
            start_recording(app, echo).await;
        }
        _ => {}
    }
}

async fn start_recording(app: &AppHandle, echo: &EchoApp) {
    // Capture source app
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
    }

    let device = echo.settings.get(|s| {
        if s.audio_device.is_empty() { None } else { Some(s.audio_device.clone()) }
    });

    let mut recorder = echo.recorder.lock().await;
    if let Err(e) = recorder.start(device.as_deref()) {
        let msg = utils::errors::to_user_facing_error(&e);
        echo.app_state.set_state(EchoState::Error, Some(msg)).await;
        return;
    }

    // Spawn audio level emitter task
    let mut level_rx = recorder.level_receiver();
    let app_handle = app.clone();
    tokio::spawn(async move {
        while level_rx.changed().await.is_ok() {
            let level = *level_rx.borrow();
            let _ = app_handle.emit("audio-level", level);
            tokio::time::sleep(std::time::Duration::from_millis(33)).await;
        }
    });

    echo.app_state.set_state(EchoState::Recording, None).await;
    audio::sounds::play_recording_start();

    // Re-activate source app
    if let Some(ref app_name) = source_app {
        let escaped = app_name.replace('\\', "\\\\").replace('"', "\\\"");
        let _ = std::process::Command::new("osascript")
            .args(["-e", &format!("tell application \"{}\" to activate", escaped)])
            .output();
    }

    let _ = app.emit("state-change", ("recording", serde_json::json!({})));
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
        // (osascript/screenshot) is hidden behind the STT round trip instead of
        // adding to time-to-first-insertion. Only when an LLM will consume it.
        let context_handle = if llm_provider != "none" && settings.get(|s| s.use_window_context) {
            Some(tokio::task::spawn_blocking(|| {
                let wctx = context::window::capture_window_context();
                context::window::format_window_context(&wctx)
            }))
        } else {
            None
        };

        let result = transcription::transcribe_audio(&stt_engine, &clean_path, &wav_path, settings).await?;

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
        if !voice_result.skip_refinement && llm_provider != "none" {
            app_state.set_state(EchoState::Refining, None).await;
            let _ = app.emit("state-change", ("refining", serde_json::json!({})));

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

            let profile_prompt = context::app_profiles::get_profile_prompt(
                source_app.as_deref(),
                &settings.get(|s| s.app_profiles.clone()),
            );

            let mut custom_prompt = settings.get(|s| s.custom_prompt.clone());
            if !profile_prompt.is_empty() {
                custom_prompt = if custom_prompt.is_empty() { profile_prompt } else { format!("{}\n\n{}", profile_prompt, custom_prompt) };
            }

            let ctx = refinement::RefinementContext {
                memory_entries: relevant.clone(),
                memory_formatted: formatted,
                window_context: Some(window_context_str),
                vocabulary_list: Some(settings.get(|s| s.vocabulary_list.clone())),
                custom_prompt: Some(custom_prompt),
                existing_field_text: app_state.inner.lock().await.existing_field_text.clone(),
                tone: Some(settings.get(|s| s.tone.clone())),
            };

            match refinement::refine(&llm_provider, &cleaned, &ctx, settings).await {
                Ok(text) => {
                    refined_text = refinement::refiner::sanitize_refined_output(&text);
                    if refined_text == "EMPTY" || refined_text.is_empty() {
                        log::info!("[pipeline] LLM returned EMPTY");
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
        }

        app_state.set_transcription(raw_text.clone(), refined_text.clone()).await;

        // Insert
        log::info!("[pipeline] Inserting: \"{}\"", refined_text);
        app_state.set_state(EchoState::Inserting, None).await;

        if !live_injected_text.is_empty() {
            insertion::text_inserter::replace_live_text(&refined_text, live_injected_text.len(), source_app.as_deref()).await?;
        } else {
            insertion::text_inserter::insert(&refined_text, source_app.as_deref()).await?;
        }

        log::info!("[pipeline] Done");
        app_state.set_state(EchoState::Idle, None).await;

        let _ = app.emit("state-change", ("idle", serde_json::json!({
            "lastResult": &refined_text[..refined_text.len().min(60)],
            "rawResult": raw_text,
        })));

        // Log run
        run_log.add(raw_text, refined_text.clone(), String::new(), stt_engine.clone(), llm_provider.clone(), pipeline_start.elapsed().as_millis() as u64, None);

        // Vocabulary learning
        memory::vocabulary::analyze_and_learn(memory, &cleaned, &refined_text);

        // Notification
        let _ = app.emit("notification", serde_json::json!({
            "title": "Echo",
            "body": if refined_text.len() > 80 { format!("{}...", &refined_text[..80]) } else { refined_text },
        }));

        Ok(())
    }.await;

    if let Err(e) = result {
        let msg = utils::errors::to_user_facing_error(&e);
        log::error!("[pipeline] ERROR: {}", msg);
        app_state.set_state(EchoState::Error, Some(msg.clone())).await;
        let _ = app.emit("state-change", ("error", serde_json::json!({ "error": msg })));

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
    env_logger::init();

    let echo = EchoApp {
        app_state: AppState::new(),
        settings: SettingsStore::new(),
        memory: MemoryStore::new(),
        templates: TemplateStore::new(),
        run_log: RunLog::new(),
        recorder: Arc::new(Mutex::new(AudioRecorder::new())),
        live_transcriber: Arc::new(Mutex::new(LiveTranscriber::new())),
    };

    // Pre-compile Swift binaries
    utils::swift_binary::ensure_swift_binary("fn-monitor", "scripts/fn-monitor.swift");
    utils::swift_binary::ensure_swift_binary("live-transcribe", "scripts/live-transcribe.swift");
    utils::swift_binary::ensure_swift_binary("transcribe", "scripts/transcribe.swift");

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

            let _tray = TrayIconBuilder::new()
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

            // Register global shortcuts
            let hotkey = app.state::<EchoApp>().settings.get(|s| s.hotkey.clone());
            let app_handle = app.handle().clone();
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let hotkey_str = hotkey.replace("CommandOrControl", "CmdOrCtrl");
            if let Err(e) = app.global_shortcut().on_shortcut(hotkey_str.as_str(), move |_app, _shortcut, event| {
                if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    let app = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = app.state::<EchoApp>();
                        handle_toggle(&app, &state).await;
                    });
                }
            }) {
                log::error!("[echo] Failed to register hotkey {}: {}", hotkey_str, e);
            } else {
                log::info!("[echo] Hotkey registered: {}", hotkey_str);
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
