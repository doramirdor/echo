//! Monitors the fn/Globe key and emits low-level, instant actions, mirroring
//! `src/main/fnKeyMonitor.ts`:
//! - `Press`:       fn pressed down (every fn-down except a double-click's 2nd tap)
//! - `Release`:     fn released (every fn-up)
//! - `DoubleClick`: fn tapped twice within DOUBLE_CLICK_WINDOW_MS
//!
//! Gesture *meaning* (hold-to-talk vs hands-free vs stray tap) is decided by the
//! consumer (`handle_fn_action` in lib.rs) from the press/release timing, so this
//! monitor adds no latency and recording can begin the instant fn goes down.
//!
//! The `fn-monitor` Swift helper prints `fn-down`/`fn-up` lines (plus
//! `im-granted`/`im-denied`/`im-unknown`/`ready`); the double-click timing is all
//! done here so the helper stays trivial.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};

use crate::utils::swift_binary;

const DOUBLE_CLICK_WINDOW_MS: u64 = 280;
const RESTART_DELAY_MS: u64 = 2000;
const MAX_RESTART_ATTEMPTS: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FnAction {
    Press,
    Release,
    DoubleClick,
}

enum Internal {
    Line(String),
    TapWindowTimeout(u64),
    ProcessExited,
}

/// Start the fn-key monitor. Emits gestures on `tx`; updates `im_status`
/// ("granted"/"denied"/"unknown") as the helper reports Input Monitoring
/// permission. Self-restarts on crash up to `MAX_RESTART_ATTEMPTS`.
pub fn start(tx: mpsc::UnboundedSender<FnAction>, im_status: Arc<Mutex<String>>) {
    swift_binary::ensure_swift_binary("fn-monitor", "scripts/fn-monitor.swift");

    tauri::async_runtime::spawn(async move {
        let mut attempts: u32 = 0;
        loop {
            let bin = swift_binary::get_binary_path("fn-monitor");
            if !bin.exists() {
                log::warn!("[fn-monitor] Cannot start — binary not available");
                return;
            }

            run_once(&bin, &tx, &im_status, &mut attempts).await;

            attempts += 1;
            if attempts >= MAX_RESTART_ATTEMPTS {
                log::error!("[fn-monitor] Giving up after {} restart attempts", attempts);
                return;
            }
            log::info!(
                "[fn-monitor] Exited; restarting (attempt {}/{})",
                attempts,
                MAX_RESTART_ATTEMPTS
            );
            tokio::time::sleep(Duration::from_millis(RESTART_DELAY_MS)).await;
        }
    });
}

async fn run_once(
    bin: &Path,
    tx: &mpsc::UnboundedSender<FnAction>,
    im_status: &Arc<Mutex<String>>,
    attempts: &mut u32,
) {
    let mut child = match Command::new(bin)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            log::error!("[fn-monitor] Failed to start: {}", e);
            return;
        }
    };

    let (itx, mut irx) = mpsc::unbounded_channel::<Internal>();

    if let Some(stdout) = child.stdout.take() {
        let itx = itx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = itx.send(Internal::Line(line.trim().to_string()));
            }
            let _ = itx.send(Internal::ProcessExited);
        });
    }

    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let t = line.trim();
                if !t.is_empty() {
                    log::warn!("[fn-monitor] {}", t);
                }
            }
        });
    }

    // ── Gesture state ──
    // Classification (hold/hands-free/stray) lives in the consumer; here we only
    // disambiguate a double-tap so recording can start instantly on the first press.
    let mut last_fn_up: Option<Instant> = None;
    let mut waiting_for_second_tap = false;
    let mut tap_gen: u64 = 0; // bump to cancel a pending tap-window timer

    while let Some(ev) = irx.recv().await {
        match ev {
            Internal::ProcessExited => break,

            Internal::Line(line) => match line.as_str() {
                "fn-down" => {
                    let now = Instant::now();
                    let within_double = waiting_for_second_tap
                        && last_fn_up
                            .map(|t| {
                                now.duration_since(t).as_millis() < DOUBLE_CLICK_WINDOW_MS as u128
                            })
                            .unwrap_or(false);

                    if within_double {
                        // Second tap of a double-click — emit the high-level gesture
                        // so the consumer can latch into hands-free mode.
                        waiting_for_second_tap = false;
                        tap_gen += 1; // cancel pending tap-window timer
                        let _ = tx.send(FnAction::DoubleClick);
                    } else {
                        let _ = tx.send(FnAction::Press);
                    }
                }

                "fn-up" => {
                    last_fn_up = Some(Instant::now());
                    let _ = tx.send(FnAction::Release);

                    // Arm the double-click window; a fn-down within it is a
                    // double-click, otherwise it lapses and the next press is fresh.
                    waiting_for_second_tap = true;
                    tap_gen += 1;
                    let g = tap_gen;
                    let itx2 = itx.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(DOUBLE_CLICK_WINDOW_MS)).await;
                        let _ = itx2.send(Internal::TapWindowTimeout(g));
                    });
                }

                "im-granted" => *im_status.lock().await = "granted".into(),
                "im-denied" => *im_status.lock().await = "denied".into(),
                "im-unknown" => *im_status.lock().await = "unknown".into(),
                "ready" => {
                    *attempts = 0;
                    log::info!("[fn-monitor] Running");
                }
                _ => {}
            },

            Internal::TapWindowTimeout(g) => {
                if g == tap_gen {
                    waiting_for_second_tap = false;
                }
            }
        }
    }

    let _ = child.start_kill();
    let _ = child.wait().await;
}
