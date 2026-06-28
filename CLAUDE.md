# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Echo is

A macOS menu-bar (no dock icon) voice-to-text app. Press a hotkey, speak, and Echo records → transcribes (STT) → refines with an LLM → inserts the text at the cursor in whatever app was focused. See [README.md](README.md) for the user-facing feature list.

## Dual implementation — read this first

The app exists **twice**, and the two copies mirror each other module-for-module:

- **`src/main/` — TypeScript / Electron.** This is what `npm start` / `npm run dev` actually runs today.
- **`src-tauri/src/` — Rust / Tauri.** A port of the same logic; this is the production build target (`npm run build` → `cargo tauri build`).

The module layout is intentionally parallel: `src/main/pipeline.ts` ↔ `run_pipeline` in `src-tauri/src/lib.rs`; `src/main/transcription/groqTranscriber.ts` ↔ `src-tauri/src/transcription/groq.rs`; etc. **When you change pipeline logic, a provider, settings keys, or the IPC surface, change it in BOTH trees** or they drift. If a task only targets one runtime, say so explicitly — don't assume.

The **renderer is shared** (`src/renderer/*.html` + `settings.js`) and backend-agnostic. It only ever calls `window.echo.*`. Two adapters provide that identical API surface:
- `src/renderer/preload.ts` → Electron `ipcRenderer.invoke(...)` (dash-case channels like `get-settings`)
- `src/renderer/tauri-bridge.js` → Tauri `invoke(...)` (snake_case commands like `get_settings`)

Adding a renderer-facing capability means touching **all of**: `preload.ts`, `tauri-bridge.js`, the Electron IPC handler (`src/main/ipc.ts`), and the Tauri `#[tauri::command]` + `invoke_handler!` registration in `src-tauri/src/lib.rs`.

> The README's "Development" command list and "Project structure" are Electron-era and partly stale (it predates the Tauri port and lists scripts like `npm run dev`/`clean`/`pack` that differ from `package.json`). Trust `package.json` over the README for commands.

## Commands

```bash
npm install            # install JS deps
npm start              # build TS + launch Electron (primary dev loop)
npm test               # vitest (unit tests — TypeScript side only)
npm run test:watch     # vitest watch
npm run lint           # eslint src/ tests/
npx tsc --noEmit       # type-check without emitting (what CI runs)

npm run build          # cargo tauri build — produces the Tauri .app/.dmg
npm run setup          # scripts/setup-whisper.sh: brew sox/cmake, build whisper.cpp, download model

# Tauri dev (Rust side):
cargo tauri dev        # or: npm run tauri dev
```

Run a single test file: `npx vitest run tests/pipeline.test.ts`
Run tests matching a name: `npx vitest run -t "voice command"`

CI (`.github/workflows/ci.yml`, macOS runner) runs, in order: `tsc --noEmit` → `lint` → `test` → `build`. Note CI assumes a `dor/echo/` monorepo subpath; this checkout is standalone.

## The pipeline (core flow)

The heart of the app is the record→insert pipeline, implemented in `src/main/pipeline.ts` (`runPipeline`) and `src-tauri/src/lib.rs` (`run_pipeline`). Both do the same steps:

1. Stop recorder, post-process the WAV (noise reduction / whisper-mode gain).
2. **Transcribe** via the selected STT engine (`sttEngine` setting): `whisper` (local whisper.cpp, default), `groq`, `macos`, `deepgram`, `openai-whisper`.
3. Strip `[...]` artifacts, check template triggers, process voice commands.
4. **Refine** via the selected LLM (`llmProvider` setting), unless `none` or a voice command skipped it. Refinement is fed: relevant memory entries, vocabulary list, window/screenshot context, recent-dictation history, per-app profile prompt, existing field text, and tone. Failures fall back to the raw transcript.
5. Optional second grammar-validation LLM pass.
6. **Insert** text at the cursor (or replace already-injected live text).
7. Log the run, auto-learn vocabulary, fire a notification.

Provider selection is a factory keyed off settings: see `createRefiner()` / `transcribeAudio()` in `pipeline.ts`, and `refinement::refine` / `transcription::transcribe_audio` in Rust. To add a provider: implement the refiner/transcriber, register it in that switch in **both** trees, and add its settings keys.

## Dictation intelligence

Layered on top of the base pipeline to make recognition accurate and natural — all working with no paid services. **Product scope: free, fully local, desktop-only — no accounts/login, plans/billing, team, or mobile.**

- **STT vocabulary biasing** — `buildSpeechBiasPrompt()` (`transcription/speechBias.ts`) builds an initial prompt from the user's vocabulary, learned memory terms, and scanned project jargon, then passes it to the STT engine so domain terms are recognized correctly *before* the LLM runs. Wired for local whisper (`--prompt`) and the cloud Whisper engines (Groq, OpenAI Whisper) in `transcribeAudio()`.
- **Caret-aware sentence continuation** — `scripts/field-context.swift` reads the text before/after the caret via the Accessibility API; `joinContinuation()` (`insertion/continuation.ts`) fixes spacing/capitalization so dictation continues mid-sentence. Deterministic, so it works even with `llmProvider: none`.
- **Project jargon** — `CodebaseAnalyzer` context feeds both STT biasing and every refiner via `RefinementContext.projectContext`.
- **Accent/dialect** — `transcriptionLanguage` is honored by every engine; the default refiner prompt is instructed to preserve the speaker's dialect/spelling (don't Americanize).
- Speed defaults: whisper runs multi-threaded with `ggml-base.en.bin`; the second grammar-validation pass is **off** by default.

## Recording trigger & state

- App state machine: `AppState` / `EchoState` (Idle, Recording, Transcribing, Refining, Inserting, Error). State changes drive the tray, the floating overlay, and renderer events.
- Two trigger paths in the Electron entry (`src/main/index.ts`): a **Swift `fn`-key monitor** (primary, supports hold / double-click / single-click) and **`globalShortcut`** fallback hotkeys (`Cmd+Shift+V` toggle, `Cmd+Shift+B` overlay). Recording modes: toggle vs. hold-to-talk; plus silence auto-stop.
- Live transcription streams partials to the overlay and injects finals into the target app while still recording; the final refined text then replaces what was injected.

## Native integration (platform-specific, macOS only)

- **Swift helper binaries** compiled on-demand from `scripts/*.swift` into `~/Library/Application Support/echo/bin/` (see `swiftBinary.ts` / `swift_binary.rs`): `fn-monitor` (hotkey), `live-transcribe` (real-time preview), `transcribe` (macOS Speech), and `field-context` (reads text around the caret for continuation).
- **`osascript` / AppleScript** is used for source-app detection, re-activating the source app, modifier-key polling (hold detection), and **text insertion** (requires Accessibility permission).
- **SoX** (`rec`) does audio capture — a hard external dependency (`brew install sox`).
- **whisper.cpp** is git-cloned and built with cmake at runtime (onboarding or `npm run setup`); models download from Hugging Face.
- Persistent data lives under `~/Library/Application Support/echo/` (`bin/`, `models/`, settings, memory, run log). Settings use `electron-store` on the Electron side.

## Testing

Vitest tests in `tests/` cover the **TypeScript** side only (pipeline, refiner, voice commands, app profiles, run log, app state, errors). There is no equivalent Rust test suite wired into CI — when you change Rust logic, the JS tests won't catch regressions, so verify the Tauri build/behavior manually.

## Conventions

- `@typescript-eslint/no-explicit-any` is **off** and unused vars are a warning (prefix intentional unused with `_`). TS is `strict`.
- Errors shown to users go through `toUserFacingError` (`utils/errors.ts` / `utils/errors.rs`); logging through the `logger` module, not bare `console` in new code where a logger exists.
