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
//!
//! Self-restarts on crash up to `MAX_RESTART_ATTEMPTS`. When that budget is
//! exhausted the monitor sends a *dead* signal exactly once (carrying the last
//! Input Monitoring status) on `dead_tx` so lib.rs can surface it to the user,
//! instead of silently going away. The budget is then refreshed every
//! `RESTART_BUDGET_RESET_MS` and retries automatically, so a transient failure
//! (e.g. flaky Input Monitoring state) never kills the primary hotkey for the
//! rest of a days-long session.

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
// After the restart budget is exhausted, allow a fresh burst of retries this
// often — otherwise a transient failure (e.g. flaky Input Monitoring state)
// would kill the primary hotkey for the rest of a days-long session.
const RESTART_BUDGET_RESET_MS: u64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FnAction {
    Press,
    Release,
    DoubleClick,
    /// Another key went down while fn was held — fn is being used as a modifier
    /// (e.g. fn+Delete, fn+←), not pressed on its own. The consumer should
    /// cancel/ignore the in-progress optimistic recording.
    Combo,
}

enum Internal {
    Line(String),
    TapWindowTimeout(u64),
    ProcessExited,
}

/// Start the fn-key monitor. Emits gestures on `tx`; updates `im_status`
/// ("granted"/"denied"/"unknown") as the helper reports Input Monitoring
/// permission. Self-restarts on crash up to `MAX_RESTART_ATTEMPTS`; when that
/// budget is exhausted it sends the last Input Monitoring status once on
/// `dead_tx` (mirroring the TS `'dead'` event) and then keeps retrying every
/// `RESTART_BUDGET_RESET_MS`.
///
/// `dead_tx` also fires once when the helper reports `im-denied`. Without Input
/// Monitoring the helper does NOT fail: its listen-only tap is created fine, it
/// prints `ready`, and it then sits there receiving zero events forever — so the
/// restart budget never trips and the fn hotkey is dead with nothing said. The
/// denied report is the only signal we get, so treat it as a failure too.
pub fn start(
    tx: mpsc::UnboundedSender<FnAction>,
    dead_tx: mpsc::UnboundedSender<String>,
    im_status: Arc<Mutex<String>>,
) {
    swift_binary::ensure_swift_binary("fn-monitor", "scripts/fn-monitor.swift");

    tauri::async_runtime::spawn(async move {
        // Restart budget + dead-latch, shared between the run/restart cycle and
        // the periodic budget-reset ticker below. Both live on this single task,
        // so a plain local is enough — no lock needed.
        let mut attempts: u32 = 0;
        let mut dead_emitted = false;
        // Latched for the whole app run (never reset by `ready`/restarts) so a
        // restart loop can't turn one missing grant into a notification stream.
        let mut im_denied_emitted = false;

        // Periodically refresh the restart budget so an exhausted monitor gets a
        // fresh burst of retries instead of staying dead for the rest of the
        // session. The ticker fires on the same task as the run loop, in between
        // `run_once` invocations (i.e. while sleeping before a restart, or after
        // the budget was exhausted and we're idling on the long sleep below).
        let mut budget_reset = tokio::time::interval(Duration::from_millis(RESTART_BUDGET_RESET_MS));
        // Measure each refresh as a full interval from when we last (re)armed the
        // timer — not from accumulated missed ticks — so a long healthy run
        // doesn't make the ticker fire instantly the moment we start waiting.
        budget_reset.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The first tick completes immediately; skip it so we don't reset on start.
        budget_reset.tick().await;

        loop {
            let bin = swift_binary::get_binary_path("fn-monitor");
            if !bin.exists() {
                log::warn!("[fn-monitor] Cannot start — binary not available");
                return;
            }

            // `run_once` returns when the helper process exits. `attempts` and
            // `dead_emitted` are reset to 0/false from inside on every `ready`.
            run_once(
                &bin,
                &tx,
                &dead_tx,
                &im_status,
                &mut attempts,
                &mut dead_emitted,
                &mut im_denied_emitted,
            )
            .await;

            if attempts < MAX_RESTART_ATTEMPTS {
                attempts += 1;
                log::info!(
                    "[fn-monitor] Exited; restarting (attempt {}/{})",
                    attempts,
                    MAX_RESTART_ATTEMPTS
                );
                // Sleep before restarting, but let the budget-reset ticker also
                // fire during the wait.
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(RESTART_DELAY_MS)) => {}
                    _ = budget_reset.tick() => {
                        attempts = 0;
                        dead_emitted = false;
                        log::info!("[fn-monitor] Restart budget refreshed");
                    }
                }
            } else {
                // Budget exhausted — surface the failure once (the primary hotkey
                // is gone until we recover) instead of failing silently.
                if !dead_emitted {
                    dead_emitted = true;
                    let im = im_status.lock().await.clone();
                    log::warn!("[fn-monitor] Restart budget exhausted — retrying in ~10 minutes");
                    let _ = dead_tx.send(im);
                }
                // Idle for one full budget window (measured from now), then
                // refresh the retry budget and loop back to try the helper again.
                tokio::time::sleep(Duration::from_millis(RESTART_BUDGET_RESET_MS)).await;
                attempts = 0;
                dead_emitted = false;
                // Re-arm the shared ticker so the fast-restart branch's next
                // window is also measured from this refresh, not stale ticks.
                budget_reset.reset();
                log::info!("[fn-monitor] Restart budget refreshed — retrying");
            }
        }
    });
}

async fn run_once(
    bin: &Path,
    tx: &mpsc::UnboundedSender<FnAction>,
    dead_tx: &mpsc::UnboundedSender<String>,
    im_status: &Arc<Mutex<String>>,
    attempts: &mut u32,
    dead_emitted: &mut bool,
    im_denied_emitted: &mut bool,
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

                "fn-combo" => {
                    let _ = tx.send(FnAction::Combo);
                }

                "im-granted" => *im_status.lock().await = "granted".into(),
                "im-denied" => {
                    *im_status.lock().await = "denied".into();
                    // The tap still gets created and `ready` still follows — the
                    // helper just never receives an event. Nothing else will ever
                    // notice, so surface it here (once per app run).
                    if !*im_denied_emitted {
                        *im_denied_emitted = true;
                        let _ = dead_tx.send("denied".to_string());
                    }
                }
                "im-unknown" => *im_status.lock().await = "unknown".into(),
                "ready" => {
                    // The helper came up cleanly — refresh the restart budget and
                    // re-arm the dead signal so a future exhaustion fires again.
                    *attempts = 0;
                    *dead_emitted = false;
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
