//! Monitors the fn/Globe key and emits high-level gestures, mirroring
//! `src/main/fnKeyMonitor.ts`:
//! - `HoldStart`:  fn held past threshold (start hold-to-record)
//! - `HoldEnd`:    fn released after a hold (stop hold-to-record)
//! - `DoubleClick`: fn double-tapped (toggle recording on/off)
//! - `SingleClick`: fn tapped once (stops toggle recording if active)
//!
//! The `fn-monitor` Swift helper prints `fn-down`/`fn-up` lines (plus
//! `im-granted`/`im-denied`/`im-unknown`/`ready`); the gesture timing is all
//! done here so the helper stays trivial.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};

use crate::utils::swift_binary;

const HOLD_THRESHOLD_MS: u64 = 120;
const DOUBLE_CLICK_WINDOW_MS: u64 = 400;
const RESTART_DELAY_MS: u64 = 2000;
const MAX_RESTART_ATTEMPTS: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FnAction {
    HoldStart,
    HoldEnd,
    DoubleClick,
    SingleClick,
}

enum Internal {
    Line(String),
    HoldTimeout(u64),
    SingleTapTimeout(u64),
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
    let mut last_fn_up: Option<Instant> = None;
    let mut in_hold = false;
    let mut waiting_for_second_tap = false;
    let mut suppress_next_up = false;
    let mut hold_gen: u64 = 0; // bump to cancel a pending hold timer
    let mut tap_gen: u64 = 0; // bump to cancel a pending single-tap timer

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
                        // Second tap of a double-click.
                        waiting_for_second_tap = false;
                        tap_gen += 1; // cancel pending single-tap
                        hold_gen += 1; // cancel any pending hold
                        suppress_next_up = true;
                        let _ = tx.send(FnAction::DoubleClick);
                    } else {
                        // Arm the hold timer.
                        hold_gen += 1;
                        let g = hold_gen;
                        let itx2 = itx.clone();
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(HOLD_THRESHOLD_MS)).await;
                            let _ = itx2.send(Internal::HoldTimeout(g));
                        });
                    }
                }

                "fn-up" => {
                    last_fn_up = Some(Instant::now());

                    if suppress_next_up {
                        suppress_next_up = false;
                    } else if in_hold {
                        in_hold = false;
                        let _ = tx.send(FnAction::HoldEnd);
                    } else {
                        hold_gen += 1; // cancel pending hold (tap was too short)
                        waiting_for_second_tap = true;
                        tap_gen += 1;
                        let g = tap_gen;
                        let itx2 = itx.clone();
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(DOUBLE_CLICK_WINDOW_MS)).await;
                            let _ = itx2.send(Internal::SingleTapTimeout(g));
                        });
                    }
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

            Internal::HoldTimeout(g) => {
                if g == hold_gen && !in_hold {
                    in_hold = true;
                    let _ = tx.send(FnAction::HoldStart);
                }
            }

            Internal::SingleTapTimeout(g) => {
                if g == tap_gen && waiting_for_second_tap {
                    waiting_for_second_tap = false;
                    let _ = tx.send(FnAction::SingleClick);
                }
            }
        }
    }

    let _ = child.start_kill();
    let _ = child.wait().await;
}
