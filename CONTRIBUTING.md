# Contributing to Echo

Thanks for your interest in improving Echo! This project is a free, fully local,
open-source voice keyboard for macOS, and contributions of every size are
welcome — from typo fixes to new transcription engines.

## Before you start

- **Be respectful.** This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- **Search first.** Check existing [issues](https://github.com/doramirdor/echo-tauri/issues)
  and [pull requests](https://github.com/doramirdor/echo-tauri/pulls) before opening a new one.
- **Open an issue for big changes.** For anything beyond a small fix, file an issue
  to discuss the approach before investing a lot of time.

## The dual implementation — read this first

Echo exists **twice**, and the two copies mirror each other module-for-module:

- **`src/main/` — TypeScript / Electron.** What `npm start` runs today (primary dev loop).
- **`src-tauri/src/` — Rust / Tauri.** A port of the same logic; the production build target.

The module layout is intentionally parallel (`src/main/pipeline.ts` ↔ `run_pipeline`
in `src-tauri/src/lib.rs`, etc.). **When you change pipeline logic, a provider, a
settings key, or the IPC surface, change it in BOTH trees** or they drift. If your PR
only targets one runtime, say so explicitly in the description.

The renderer (`src/renderer/*.html` + `settings.js`) is shared and backend-agnostic —
it only ever calls `window.echo.*`. Adding a renderer-facing capability means touching
**all of**: `preload.ts`, `tauri-bridge.js`, the Electron IPC handler (`src/main/ipc.ts`),
and the Tauri `#[tauri::command]` + `invoke_handler!` registration in `src-tauri/src/lib.rs`.

See [CLAUDE.md](CLAUDE.md) for a deeper architectural tour.

## Development setup

```bash
brew install sox            # required: audio capture
npm install                 # install JS deps
npm start                   # build TS + launch Electron (primary dev loop)
```

Optional, for local Whisper:

```bash
npm run setup               # build whisper.cpp + download the model
```

## Before you open a PR

Run the same checks CI runs, in order:

```bash
npx tsc --noEmit            # type-check
npm run lint                # eslint
npm test                    # vitest (TypeScript side)
```

For Rust changes, also verify the Tauri build manually (`cargo tauri build`) —
there is no Rust test suite in CI, so the JS tests won't catch Rust regressions.

## Pull request guidelines

- Keep PRs focused — one logical change per PR.
- Write a clear description: what changed, why, and which tree(s) you touched.
- Match the surrounding code's style. ESLint and `strict` TypeScript are enforced.
- Add or update tests in `tests/` for behavior changes on the TypeScript side.
- Update docs (`README.md`, `docs/`) when you change user-facing behavior.

## Adding a provider

To add a new STT or LLM provider:

1. Implement the transcriber/refiner in **both** trees.
2. Register it in the factory switch (`transcribeAudio()` / `createRefiner()` in
   `pipeline.ts`; `transcription::transcribe_audio` / `refinement::refine` in Rust).
3. Add its settings keys to the settings schema in both trees.
4. Document it in `docs/PRIVACY.md` (what data leaves the machine).

## Product scope

Echo is intentionally **free, fully local, and desktop-only** — no accounts/login,
no plans/billing, no team features, and no mobile app. Please keep proposals within
that scope.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
