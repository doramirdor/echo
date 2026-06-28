use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use crate::utils::swift_binary;

pub enum LiveEvent {
    Partial(String),
    Final(String),
}

pub struct LiveTranscriber {
    process: Option<Child>,
}

impl LiveTranscriber {
    pub fn new() -> Self {
        Self { process: None }
    }

    pub fn start(&mut self) -> Option<mpsc::UnboundedReceiver<LiveEvent>> {
        if self.process.is_some() {
            return None;
        }

        let bin = swift_binary::get_binary_path("live-transcribe");
        if !bin.exists() {
            log::warn!("[live-transcribe] Binary not available");
            return None;
        }

        let mut child = match Command::new(bin.to_str().unwrap_or(""))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                log::error!("[live-transcribe] Failed to start: {}", e);
                return None;
            }
        };

        let (tx, rx) = mpsc::unbounded_channel();

        if let Some(stdout) = child.stdout.take() {
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    if line.starts_with("partial:") {
                        let _ = tx.send(LiveEvent::Partial(line[8..].to_string()));
                    } else if line.starts_with("final:") {
                        let _ = tx.send(LiveEvent::Final(line[6..].to_string()));
                    }
                }
            });
        }

        self.process = Some(child);
        Some(rx)
    }

    pub async fn stop(&mut self) {
        if let Some(ref mut proc) = self.process {
            if let Some(ref mut stdin) = proc.stdin {
                let _ = stdin.write_all(b"stop\n").await;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            let _ = proc.kill().await;
        }
        self.process = None;
    }

    pub fn force_stop(&mut self) {
        if let Some(ref mut proc) = self.process {
            let _ = proc.start_kill();
        }
        self.process = None;
    }
}
