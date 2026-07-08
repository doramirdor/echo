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

    pub fn stop(&mut self) {
        // Detach immediately so a rapid re-record can start() a fresh session
        // while this (captured) one drains its final result. The delayed SIGKILL
        // targets the captured old process, never whatever is current.
        let mut proc = match self.process.take() {
            Some(p) => p,
            None => return,
        };
        tokio::spawn(async move {
            if let Some(ref mut stdin) = proc.stdin {
                let _ = stdin.write_all(b"stop\n").await;
            }
            // Give it a moment to flush its final result, then force kill.
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            let _ = proc.kill().await;
        });
    }

    pub fn force_stop(&mut self) {
        // Capture, clear the handle, then kill — a later drain of this process
        // must not race with a newer session's handle.
        if let Some(mut proc) = self.process.take() {
            let _ = proc.start_kill();
        }
    }
}
