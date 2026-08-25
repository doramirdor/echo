# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Echo is

A macOS menu-bar (no dock icon) voice-to-text app. Press a hotkey, speak, and Echo records → transcribes (STT) → refines with an LLM → inserts the text at the cursor in whatever app was focused. See [README.md](README.md) for the user-facing feature list.

## Architecture — single tree (Rust / Tauri)

The app is **Rust / Tauri only**. All backend logic lives in **`src-tauri/src/`**; `npm run build` → `cargo tauri build` produces the `.app`/`.dmg`.

> **History:** Echo used to carry a second, parallel `src/main/` TypeScript / Electron tree that mirrored the Rust one module-for-module. That tree (and its `vitest` suite) was deleted when the app went Tauri-only — its unit tests were ported to Rust `#[cfg(test)]` modules. If you see stale references to `src/main/*.ts`, `preload.ts`, Electron IPC, or "both trees" in older docs/comments, they no longer apply.

The **renderer** (`src/renderer/*.html` + `settings.js`) is static and backend-agnostic. It calls `window.echo.*`, provided by a single adapter, `src/renderer/tauri-bridge.js` → Tauri `invoke(...)` (snake_case commands like `get_settings`). Tauri serves `src/renderer` directly (`frontendDist` in `tauri.conf.json`) — there is no frontend build step.

Adding a renderer-facing capability means touching: `src/renderer/tauri-bridge.js` and the Tauri `#[tauri::command]` + `invoke_handler!` registration in `src-tauri/src/lib.rs`.

> The README's "Development" command list and "Project structure" are older and partly stale. Trust `package.json` over the README for commands.

## Commands

```bash
npm install            # install the one JS dev dep (@tauri-apps/cli)
npm start              # tauri dev — build + launch the app (primary dev loop; alias: npm run dev)
npm test               # cargo test (Rust unit suite) — the only test suite
npm run lint           # cargo clippy
npm run build          # cargo tauri build — produces the Tauri .app/.dmg
npm run setup          # scripts/setup-whisper.sh: brew git/cmake, build whisper.cpp, download model
bash scripts/package-mac.sh   # build a SHAREABLE .dmg: bundles prebuilt helpers + whisper-cli + model so the recipient needs no dev tools (see SHARE.md)
```

Run a single Rust test: `cargo test --manifest-path src-tauri/Cargo.toml refiner::` (or any module path / test-name substring).

CI (`.github/workflows/ci.yml`, macOS runner) runs: `cargo clippy` → `cargo test` → `cargo build`.

## The pipeline (core flow)

The heart of the app is the record→insert pipeline, implemented in `src/main/pipeline.ts` (`runPipeline`) and `src-tauri/src/lib.rs` (`run_pipeline`). Both do the same steps:

1. Stop recorder, post-process the WAV (noise reduction / whisper-mode gain).
2. **Transcribe** via the selected STT engine (`sttEngine` setting): `whisper` (local whisper.cpp, default), `parakeet` (local parakeet.cpp, opt-in), `groq`, `macos`, `deepgram`, `openai-whisper`.
3. Strip `[...]` artifacts, check template triggers, process voice commands.
4. **Refine** via the selected LLM (`llmProvider` setting), unless `none` or a voice command skipped it. Refinement is fed: relevant memory entries, vocabulary list, window/screenshot context, recent-dictation history, per-app profile prompt, existing field text, and tone. Failures fall back to the raw transcript.
5. Optional second grammar-validation LLM pass.
6. **Insert** text at the cursor (or replace already-injected live text).
7. Log the run, auto-learn vocabulary, fire a notification.

Provider selection is a factory keyed off settings: `refinement::refine` / `transcription::transcribe_audio` in `src-tauri/src/`. To add a provider: implement the refiner/transcriber, register it in that switch, and add its settings keys.

## Dictation intelligence

Layered on top of the base pipeline to make recognition accurate and natural — all working with no paid services. **Product scope: free, fully local, desktop-only — no accounts/login, plans/billing, team, or mobile.**

- **STT vocabulary biasing** — `build_speech_bias_prompt()` (`transcription/speech_bias.rs`) builds an initial prompt from the user's vocabulary, learned memory terms, and scanned project jargon, then passes it to the STT engine so domain terms are recognized correctly *before* the LLM runs. Wired for local whisper (`--prompt`) and the cloud Whisper engines (Groq, OpenAI Whisper) in `transcribe_audio()`. **Not available on `parakeet`/`macos`** — Parakeet is a transducer and takes no initial prompt, so on those engines jargon is only fixed downstream by the refiner. That's the main reason whisper stays the default.
- **Caret-aware sentence continuation** — `scripts/field-context.swift` reads the text before/after the caret via the Accessibility API; `join_continuation()` (`insertion/continuation.rs`) fixes spacing/capitalization so dictation continues mid-sentence. Deterministic, so it works even with `llmProvider: none`.
- **Project jargon** — `CodebaseAnalyzer` context feeds both STT biasing and every refiner via `RefinementContext.projectContext`.
- **Accent/dialect** — `transcriptionLanguage` is honored by every engine; the default refiner prompt is instructed to preserve the speaker's dialect/spelling (don't Americanize).
- **Content-aware auto-formatting** — `detect_content_type()` (`refinement/refiner.rs`) heuristically classifies dictation as list/email/paragraph and appends a per-type formatting section to the prompt. Gated by the `autoFormatContent` setting (default on) and only for a fresh field (not mid-sentence continuation).
- **App profiles are additive** — per-app profile prompts (coding/shell/prose/chat) are passed as `appProfilePrompt` and *appended* to the base prompt, NOT used as the base (a user `customPrompt` still replaces the base). This keeps the default rules (self-correction, filler removal, EMPTY sentinel) active in every app.
- **Instant insert** — on stop, if nothing was injected live, the raw transcript is inserted immediately and then replaced with the refined text via `replaceLiveText` once refinement lands (Wispr-style "see text now, it polishes itself").
- Speed defaults: whisper runs multi-threaded (`-t` = cores−1) with `ggml-base.en.bin`; the second grammar-validation pass is **on** by default (accuracy/zero-edit parity — toggle with the `grammarCheck` setting).

## Recording trigger & state

- App state machine: `AppState` / `EchoState` (Idle, Recording, Transcribing, Refining, Inserting, Error). State changes drive the tray, the floating overlay, and renderer events.
- Two trigger paths in the Tauri entry (`src-tauri/src/lib.rs`, with `fn_monitor.rs`): a **Swift `fn`-key monitor** (primary, supports hold / double-click / single-click) and **global-shortcut** fallback hotkeys (`Cmd+Shift+V` toggle, `Cmd+Shift+B` overlay). Recording modes: toggle vs. hold-to-talk; plus silence auto-stop.
- Live transcription streams partials to the overlay and injects finals into the target app while still recording; the final refined text then replaces what was injected.

## Native integration (platform-specific, macOS only)

- **Swift helper binaries** compiled on-demand from `scripts/*.swift` into `~/Library/Application Support/echo/bin/` (see `swift_binary.rs`): `fn-monitor` (hotkey), `live-transcribe` (real-time preview), `transcribe` (macOS Speech), `field-context` (reads text around the caret for continuation), and `record` (native mic capture).
- **`osascript` / AppleScript** is used for source-app detection, re-activating the source app, modifier-key polling (hold detection), and **text insertion** (requires Accessibility permission).
- **Audio capture is native** — `scripts/record.swift` streams 16kHz mono 16-bit PCM via `AVAudioEngine` (replacing the old `rec`), so recording has **no hard external dependency**. **SoX** (`sox`) is now *optional*: if on PATH it adds noise reduction + upload compression during post-processing/upload encoding (`audio/recorder.rs`); if absent those steps are skipped and the raw recording is used. Dependency checks verify the native recorder, not sox.
- **whisper.cpp** is git-cloned and built with cmake at runtime (onboarding or `npm run setup`); models download from Hugging Face. **Packaged (shareable) builds** instead **bundle** prebuilt native helpers + `whisper-cli` + the model as app resources and seed them into `~/Library/Application Support/echo/{bin,models}` on first run (`src-tauri/src/utils/provision.rs`, staged by `scripts/package-mac.sh`), so the recipient needs no Xcode tools / git / cmake / network. The packaged app's `Info.plist` (`src-tauri/Info.plist`) carries the `NSMicrophone`/`NSSpeechRecognition`/`NSAppleEvents` usage strings required for the permission prompts.
- Persistent data lives under `~/Library/Application Support/echo/` (`bin/`, `models/`, settings, memory, run log). The support dir can be overridden with the `ECHO_SUPPORT_DIR` env var (used by unit tests to avoid touching real data). Settings persistence lives in `settings.rs`.

## Testing

Rust unit tests live in `#[cfg(test)]` modules next to the code (`cargo test`, run via `npm test`) — pipeline helpers, refiner, voice commands, app profiles, speech bias, continuation, edit learner, errors, sigv4, etc. This is the only suite. Some behavior is integration-only and not unit-covered (the full `transcribe_with_fallback` flow, provider HTTP round-trips, disk-persistence paths); verify those against a real `cargo tauri build`/run. Tests that would write to `~/Library/Application Support/echo` must set `ECHO_SUPPORT_DIR` to a temp dir first (see `edit_learner.rs` tests) so they never clobber real user data.

## Conventions

- Rust is `strict` clippy-clean where practical; prefix intentionally-unused bindings with `_`.
- Errors shown to users go through `to_user_facing_error` (`utils/errors.rs`); logging through the `logger` module, not bare `println!`/`eprintln!` in new code where a logger exists.
