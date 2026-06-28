use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{Mutex, watch};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EchoState {
    Idle,
    Recording,
    Transcribing,
    Refining,
    Inserting,
    Error,
}

impl std::fmt::Display for EchoState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EchoState::Idle => write!(f, "idle"),
            EchoState::Recording => write!(f, "recording"),
            EchoState::Transcribing => write!(f, "transcribing"),
            EchoState::Refining => write!(f, "refining"),
            EchoState::Inserting => write!(f, "inserting"),
            EchoState::Error => write!(f, "error"),
        }
    }
}

pub struct AppStateInner {
    pub state: EchoState,
    pub error_message: Option<String>,
    pub last_transcription: Option<String>,
    pub last_refined_text: Option<String>,
    pub source_app: Option<String>,
    pub existing_field_text: Option<String>,
    pub context_result: Option<String>,
    pub live_injected_text: String,
    pub fn_hold_recording: bool,
    pub hotkey_hold_recording: bool,
}

impl Default for AppStateInner {
    fn default() -> Self {
        Self {
            state: EchoState::Idle,
            error_message: None,
            last_transcription: None,
            last_refined_text: None,
            source_app: None,
            existing_field_text: None,
            context_result: None,
            live_injected_text: String::new(),
            fn_hold_recording: false,
            hotkey_hold_recording: false,
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub inner: Arc<Mutex<AppStateInner>>,
    pub state_tx: watch::Sender<(EchoState, Option<String>)>,
    pub state_rx: watch::Receiver<(EchoState, Option<String>)>,
}

impl AppState {
    pub fn new() -> Self {
        let (tx, rx) = watch::channel((EchoState::Idle, None));
        Self {
            inner: Arc::new(Mutex::new(AppStateInner::default())),
            state_tx: tx,
            state_rx: rx,
        }
    }

    pub async fn set_state(&self, state: EchoState, error: Option<String>) {
        let previous;
        {
            let mut inner = self.inner.lock().await;
            previous = inner.state;
            inner.state = state;
            inner.error_message = error.clone();
            log::info!("[echo] {} → {}{}", previous, state, error.as_ref().map(|e| format!(" ({})", e)).unwrap_or_default());
        }
        let _ = self.state_tx.send((state, error));
    }

    pub async fn set_transcription(&self, raw: String, refined: String) {
        let mut inner = self.inner.lock().await;
        inner.last_transcription = Some(raw);
        inner.last_refined_text = Some(refined);
    }

    pub async fn get_state(&self) -> EchoState {
        self.inner.lock().await.state
    }

    pub async fn is_recording(&self) -> bool {
        self.inner.lock().await.state == EchoState::Recording
    }

    pub async fn is_busy(&self) -> bool {
        let state = self.inner.lock().await.state;
        state != EchoState::Idle && state != EchoState::Error
    }
}
