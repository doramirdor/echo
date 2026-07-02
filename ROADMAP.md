# Echo Roadmap — The best way for developers to turn speech into text

> **Thesis.** Developers and AI-native builders ("vibe coders") talk to their
> machines more than any other users — prompts, commit messages, PR reviews,
> Slack, docs, and increasingly *the entire act of building software through an
> AI agent*. Yet every mainstream dictation app (Wispr Flow, Aqua, Superwhisper)
> targets the generic knowledge worker, and the voice-coding tools that *do*
> target developers (Talon, Serenade) demand you learn a command language.
>
> Echo's wedge is the gap between them: **code-grade accuracy and prompt-native
> refinement, with zero learning curve — 100% free, local, and open source.**
> The north star is Wispr-Flow-quality flow for the person whose primary text
> box is Cursor, Claude Code, or ChatGPT.

This document is the plan to get there. It's organized by **who we're building
for**, **where we stand today** (honestly), **how we'll measure "best"**, and a
**horizon-based roadmap** mapped to the actual code.

---

## 1. Who we're building for

### Persona A — The developer
Uses voice across the whole SDLC, not just prose:
- Commit messages, PR descriptions, code-review comments
- Slack / Discord / Linear / Jira / GitHub issues
- Docs, READMEs, ADRs, design specs
- Inline code comments and docstrings
- Email and chat between all of the above

**What they need that generic dictation gets wrong:** identifiers spelled
exactly (`fetchUserById`, not "fetch user by id"), CLI syntax preserved
(`rm -rf`, `$HOME`, `|`), no "helpful" Americanization or rephrasing, and text
that drops cleanly into a terminal, an editor, or a chat box without cleanup.

### Persona B — The vibe coder (the growth bet)
Builds primarily by **prompting an AI agent** — Cursor, Claude Code, Windsurf,
Copilot Chat, ChatGPT, Claude.ai, v0, Bolt, Lovable, Replit Agent. For them the
prompt box *is* the programming language. They:
- Dictate long, detailed feature descriptions and bug reports
- Reference "this function", "the error above", "that file"
- Alternate between describing intent and pasting code/errors
- Are bottlenecked by typing speed — they think faster than they type, and a
  richer prompt produces better AI output

**What they need:** long-form dictation that doesn't degrade over a 90-second
monologue, refinement that *structures* a rambling prompt without deleting the
detail the agent needs, and enough on-screen context that "fix this bug" resolves
to the actual bug. **This is the largest, fastest-growing, and least-served
segment — and it's Echo's biggest opportunity.**

---

## 2. Where Echo stands today

Echo already has an unusually strong foundation for this audience. Honest
inventory:

**Strong / differentiated already**
- **Project jargon scanning** (`codebase/analyzer.ts`) — points an LLM at a repo,
  extracts terminology, feeds it into *both* STT biasing and refinement.
- **STT vocabulary biasing** (`transcription/speechBias.ts`) — fixes terms
  *during* recognition (whisper `--prompt`, Groq, OpenAI), not just after.
- **Additive per-app profiles** (`context/appProfiles.ts`) — `coding` / `shell` /
  `prose` / `email` / `chat`, auto-detected across 40+ apps, appended to (not
  replacing) the base rules.
- **Caret-aware continuation** (`insertion/continuation.ts`) — deterministic
  mid-sentence spacing/casing that works even with `llmProvider: none`.
- **Auto vocabulary learning** (`memory/vocabularyLearner.ts`) — learns
  corrections after 3 repeats, with no user action.
- **Instant-insert + replace** — Wispr-style "see it now, it polishes itself".
- **Fully local default path** — whisper.cpp + no LLM = zero network calls.
- **Insights UI** — WPM vs typing, streaks, per-app usage.

**Weak / missing for this audience**
- No **prompt-optimized** refinement — AI-coding surfaces (Cursor, Claude Code,
  ChatGPT) fall under the generic `coding`/`prose` profile, which is tuned to
  *shorten and clean*, the opposite of what a good agent prompt wants.
- Project scan is **manual and one-shot** — you browse to a folder and click; it
  doesn't follow the repo you're actually editing.
- **No editing surface** — you can't fix a transcript before it's inserted, real
  undo doesn't exist, and there's no raw→refined diff to build trust.
- **No measured accuracy** — no WER benchmark, so "best" is an assertion, not a
  number. There is also **no Rust test suite** (only the TS tree is tested),
  which is a correctness risk given the app *ships* the Rust/Tauri build.
- **Latency is unmeasured and un-streamed** — refinement is one blocking call; no
  time-to-first-token, no keep-warm model.
- **Distribution friction** — no notarized DMG / Homebrew cask in the README
  flow; setup still assumes dev tools.

---

## 3. How we'll measure "best" (success metrics)

"Best transcript app for developers" has to be provable. Targets to instrument
and publish:

| Metric | Definition | Target |
|---|---|---|
| **Dev-WER** | Word error rate on a **developer-speech corpus** (identifiers, CLI, library names, prompts) — a benchmark we build | Beat raw Whisper by ≥40%; ≤3% on the jargon set |
| **Zero-edit rate** | % of dictations inserted with no manual correction | ≥85% for prose, ≥70% for code/prompts |
| **Time-to-first-text** | Stop → first characters on screen | p50 < 400ms (instant-insert already helps) |
| **Time-to-final** | Stop → refined text settled | p50 < 1.5s, p95 < 3s (local path) |
| **Long-form stability** | WER on 90s+ continuous dictation vs 10s | < 1.5× degradation |
| **Insert reliability** | Successful cursor insertions | ≥99.5% across top 20 dev apps |

Build the harness *first* (see Horizon 1) so every later change is judged against
it, not vibes.

---

## 4. Product pillars

Everything below ladders up to five pillars:

1. **Talk to your AI agent** — be the best voice interface for coding agents.
2. **Code-grade accuracy** — jargon, symbols, and CLI that "just work", zero-config.
3. **Instant flow** — sub-second, streaming, keep-warm.
4. **Trust & control** — edit, undo, diff, per-recording overrides.
5. **Developer-native distribution** — notarized, scriptable, config-as-code, benchmarked.

---

## 5. The roadmap

> **Status legend:** ✅ shipped · 🟡 partially shipped · ⬜ not started.
> A first implementation pass has landed the flagship wedge items across **both**
> the TS and Rust trees with unit tests (117 TS tests, 24 Rust tests green).

### 🟢 Horizon 1 — Now (0–6 weeks): sharpen the wedge, prove quality

**1.1 Prompt Mode — the vibe-coder profile** ⭐ *flagship* — ✅ **shipped**
Landed: new `prompt` app-profile (both trees) that maximally preserves detail and
forbids the model acting on the request; dedicated AI assistants (ChatGPT, Claude,
Perplexity, Poe, Msty, Jan, LM Studio, Cherry Studio, ChatWise) auto-detect to it;
AI-enabled editors stay `coding` but `prompt` is a first-class overridable option.
Tests in `tests/appProfiles.test.ts` + `app_profiles.rs`. The per-app override is
now user-visible via the App Profiles picker (see 3.3).
Add a new app-profile category `prompt`, auto-detected for AI-coding surfaces
(Cursor, Claude Code, Windsurf, Copilot Chat, ChatGPT, Claude.ai, Perplexity,
v0/Bolt/Lovable/Replit web apps). Its refinement prompt is the **inverse** of the
prose profile:
- Preserve every technical detail, file path, error string, and requirement —
  **never shorten or drop specifics** (an agent needs them).
- Lightly structure long instructions: turn a spoken run-on into clear sentences
  and, when the speaker clearly enumerates steps, a numbered list.
- Keep it faithful to intent; do not "answer" or expand the request.
- Where: extend `PROFILE_MAP` + `PROFILE_PROMPTS` in `context/appProfiles.ts`
  **and** `src-tauri/src/context/app_profiles.rs`; expose in the App Profiles UI.

**1.2 Zero-config repo jargon (follow the editor)** — 🟡 **partially shipped**
Landed the no-LLM extraction tier: `projectJargon.ts` / `project_jargon.rs` mine
dependency names (package.json, Cargo.toml, requirements.txt, go.mod), exported
symbols, and technical file names — deterministically, with no LLM call — cached to
`project-jargon.json` and fed into `buildSpeechBiasPrompt` so jargon biasing works
even with `llmProvider: none`. A full project scan now also refreshes this cache.
Remaining: auto-resolve the *focused editor's* repo (AX/cwd) so it triggers with
zero user action, and a settings-side "quick scan" button.

Today project scanning is a manual browse-and-click. Make it automatic: when the
focused app is an editor/terminal, resolve its working directory (front window
title, `lsof`/AX path, or the terminal's cwd) → the enclosing git repo → scan it
once and cache per-repo, refreshing when `HEAD`/manifest files change. The user
gets accurate jargon in *every* project with zero setup.
- Where: `codebase/analyzer.ts` (add repo-keyed cache + auto-trigger), wired from
  the source-app detection already in `index.ts`; mirror in `codebase/*.rs`.
- Cheaper scan tier: derive identifiers directly from `package.json` /
  `Cargo.toml` / imports / symbol index **without** an LLM call, so it works even
  with `llmProvider: none` (feeds `buildSpeechBiasPrompt` directly).

**1.3 Accuracy benchmark harness (make "best" a number)**
Build a `benchmarks/` corpus of developer speech (identifiers, CLI, library
names, prompt monologues, accented samples) with reference transcripts, and a
runner that reports **Dev-WER** per STT engine and per refinement config. Wire a
`npm run bench` and a CI job. This is the ground truth for every claim in §3.
- Start small (50–100 clips), grow via opt-in "donate this clip" from history.

**1.4 The editing surface — trust for skeptical devs**
Developers won't trust an LLM silently rewriting their code comments. Add:
- **Raw → refined diff** — ✅ **shipped**: `history/diff.ts` (word-level LCS diff
  + `changeRatio`, unit-tested) surfaced in the history view as a collapsible
  "what the LLM changed" panel with themed add/delete highlighting. Proves Echo is
  *correcting*, not *rewriting*.
- **Real undo** — ✅ **shipped** (both trees): a global hotkey (`⌘⇧U`, the
  `undoHotkey` setting) reverts the last insertion by selecting back over exactly
  the inserted characters and deleting them, reusing the proven `replaceLiveText`
  path. One-shot (won't double-delete), guarded against firing mid-pipeline, and
  cleared on EMPTY/error so it never deletes unrelated text. Shared orchestration
  in `insertion/undo.ts` (unit-tested) + `undo_last_insertion_impl` in Rust;
  exposed as a hotkey and a renderer command across preload/tauri-bridge/ipc/lib.
- **Edit-before-insert** — ⬜ (optional): a quick, dismissable transcript bubble you
  can tweak before it lands (toggle for users who want speed over control).

**1.5 Frictionless distribution**
- Notarized, signed **DMG** + **Homebrew cask** (`brew install --cask echo`), so
  the README quick-start is one line, no Xcode/cmake for end users. The packaged
  path already bundles helpers + whisper-cli + model (`utils/provision.rs`,
  `scripts/package-mac.sh`); finish signing/notarization and the updater workflow
  that landed in `40b8cbd`.

---

### 🔵 Horizon 2 — Next (6–14 weeks): speed & code-grade accuracy

**2.1 Streaming refinement + latency dashboard**
Replace the single blocking `refiner.refine()` with token-streamed replacement so
the refined text visibly resolves in place (extends the existing instant-insert /
`replaceLiveText` mechanism). Instrument `pipelineStart`→first-token→final and
show p50/p95 in the Insights tab. Target the §3 latency budget.

**2.2 Faster, bigger local STT**
- Ship **whisper-large-v3-turbo** (quantized) as an opt-in model and default to
  it on capable machines — large accuracy gain over `base.en` for jargon.
- **Metal/CoreML** acceleration for whisper.cpp; **keep the model warm** between
  dictations (cold-load is a latency tax today).
- Evaluate **NVIDIA Parakeet / distil-whisper** and streaming ASR for lower
  time-to-first-text. Judge all of it on the §1.3 harness.

**2.3 Symbol & code dictation grammar** — ✅ **shipped**
Landed `applyCodeGrammar` (both trees): spoken symbols ("open brace", "fat arrow",
"triple equals") → `{`, `=>`, `===`, and `"<style> case <words>"` → identifiers
(`snake case user id` → `user_id`; camel/pascal/kebab/constant supported). Gated to
`coding`/`shell` app profiles so it never fires in prose/email/chat, and runs after
punctuation commands so spoken "period"/symbols bound the capture. Prose-risky words
(hash, at, dollar, pipe, caret) require a disambiguating suffix. Deterministic —
works with no LLM. Tests in `tests/voiceCommands.test.ts` + `commands.rs`.

**2.4 On-screen context for "fix this"**
Vibe coders say "fix this bug" / "explain the error above". Pull the visible
editor selection or terminal tail via the Accessibility API (the same
`field-context.swift` path that already reads around the caret) and pass it as
`windowContext` so the *dictated prompt* is grounded in what's on screen. Gate
behind the existing `useWindowContext` / `captureScreenshots` settings and keep
it strictly local.

**2.5 Rust test parity in CI** — 🟡 **partially shipped**
The shipping build is Rust, but only the TS tree is tested — regressions in
`refiner.rs`, `pipeline`, `app_profiles.rs`, voice commands, and continuation go
uncaught. This pass added `#[cfg(test)]` coverage for the new logic
(`app_profiles.rs`, `voice/commands.rs`, `codebase/project_jargon.rs` — 24 Rust
tests total). Remaining: port the rest of the high-value Vitest suites to
`cargo test` and add `cargo test` to CI. Non-negotiable for a "best-in-class"
claim on the production target.

---

### 🟣 Horizon 3 — Later (3–6 months): platform & ecosystem

**3.1 Echo as a scriptable / MCP surface**
Expose Echo as (a) a small **CLI** (`echo dictate`, pipe transcripts to stdout)
and (b) an optional **local MCP server** so coding agents can *request* a voice
turn ("ask the user, out loud"). This turns Echo from a keyboard replacement into
the voice layer of the agentic dev loop — a wedge no generic dictation app has.

**3.2 Config-as-code**
Export/import settings, vocabulary, memory, templates, and per-app profiles as a
version-controllable dotfile (`~/.config/echo/echo.toml`), so developers manage
Echo like the rest of their environment and share team vocab via a repo. No
accounts, no sync backend — just files. (Directly closes the "no export/import"
gap the audit found.)

**3.3 Modes & per-app config UI**
Surface the per-app profile logic that already exists in code but not in the UI:
a picker to assign `coding`/`prompt`/`prose`/`shell`/`email`/`chat` (or a custom
prompt) per app, plus one-tap **preset modes** ("Coding", "Prompting", "Writing")
that flip STT model, refinement aggressiveness, and profile together.

**3.4 Voice macros / command palette for devs**
Composable macros beyond the current fixed voice-command table: user-defined
triggers → snippets/scripts ("insert my PR template", "commit message from
this"). Builds on `templateStore.ts`; add a management UI.

**3.5 Multi-language & code-switching**
Developers routinely mix a non-English language with English identifiers.
Improve `transcriptionLanguage: auto` handling so code terms stay English while
prose follows the speaker's language, and preserve non-Latin scripts faithfully.

---

### 🧪 Bets / exploration (validate before committing)

- **Tiny local refiner** — a small fine-tuned model (or a rules+LLM hybrid) that
  does the polish pass at ~0 cost and ~0 latency, removing the LLM dependency for
  the common case while keeping accuracy. Judge on the §1.3 harness.
- **Screen-aware agentic dictation** — Echo watches the active file/error and
  proactively offers the grounded prompt, blurring dictation and pair-programming.
- **Adaptive per-user acoustic biasing** — use the accumulating history corpus to
  personalize STT biasing beyond vocabulary (the data is already in the run log).

---

## 6. Non-goals (protect the scope)

Per the product's stated boundaries — **free, fully local, desktop-only** — these
stay out unless the thesis changes:
- No accounts / login / cloud sync backend / telemetry-by-default.
- No plans, billing, or team/seat management.
- No mobile app.
- Not a general meeting-transcription / diarization product — Echo is *dictation
  into the cursor*, and focus is the advantage.

Cloud STT/LLM providers remain **optional** power-ups; the default must always be
the zero-network local path.

---

## 7. Cross-cutting engineering health

- **Dual-tree discipline.** Every pipeline/provider/settings/profile change must
  land in **both** `src/main/*` (TS) and `src-tauri/src/*` (Rust) — the modules
  mirror each other and drift silently. Horizon 2.5 (Rust tests) makes drift
  visible.
- **Benchmark-gated changes.** After §1.3 exists, accuracy- or latency-affecting
  PRs report their Dev-WER / latency delta.
- **Provider matrix.** As STT/LLM providers grow, keep the factory switches in
  `pipeline.ts` / `refinement::refine` / `transcription::transcribe_audio` and
  their settings keys in lockstep, and health-check each in the UI.

---

## 8. Sequencing summary

| Horizon | Theme | Headline items |
|---|---|---|
| **Now** | Wedge + proof | Prompt Mode ⭐ · zero-config repo jargon · WER harness · edit/undo/diff · notarized DMG + brew |
| **Next** | Speed + accuracy | Streaming refine · turbo local STT + keep-warm · code dictation grammar · "fix this" context · Rust tests |
| **Later** | Platform | CLI/MCP surface · config-as-code · modes + per-app UI · voice macros · multi-language |
| **Bets** | Frontier | Tiny local refiner · screen-aware dictation · adaptive biasing |

**The single highest-leverage move is Prompt Mode (1.1) + zero-config repo jargon
(1.2), validated by the benchmark harness (1.3).** Together they make Echo
unambiguously the best way to *talk to your AI coding agent* — the fastest-growing
dictation use case, and the one no competitor is built for.
