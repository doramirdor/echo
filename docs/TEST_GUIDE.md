# Echo — Manual Test Guide

This guide covers everything that can't be verified by the automated suite. Run it against the real app on macOS.

**Already covered automatically** (run `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run electron:build`):
type-checking, ESLint, 54 unit tests (pipeline, refiner, voice commands, app profiles, run log, app state, errors, continuation, speech-bias), and that all renderer HTML/JS parses. Everything below needs a human because it depends on the GUI, microphone, macOS permissions, or live transcription.

How to run the app: `npm start` (builds + launches Electron). Echo is a **menu-bar app** — there's no dock window; look for the Echo icon in the macOS menu bar. Open the hub from **tray → Settings**.

Legend: ☐ = test step, → = expected result.

---

## 0. Setup / prerequisites

☐ `brew install sox cmake` installed, then `npm install`, then `npm start`.
→ App launches, Echo icon appears in the menu bar, no errors in the terminal.

☐ First launch with no prior config.
→ The onboarding window opens automatically (it only shows while `onboardingComplete` is false).

---

## 1. Onboarding wizard

☐ **Step 1 — Prerequisites.** Observe the four rows: Microphone, Accessibility, Input monitoring, SoX.
→ Light/cream themed window with Echo logo and "on-device / free / no account" chips. Microphone shows "Will prompt"; Accessibility / Input monitoring / SoX show live "Granted" / "Not granted" / "Installed" badges (green/red).

☐ With Accessibility **not** granted, click **Open System Settings** next to it.
→ macOS opens Privacy & Security → Accessibility. After enabling Echo (or "Electron" in dev) and returning, the badge flips to "Granted" within ~3s (it polls).

☐ With Input Monitoring **not** granted, click its **Open System Settings**.
→ Opens Privacy & Security → Input Monitoring. After enabling + restarting the app, the badge shows "Granted".

☐ **Step 2 — Speech-to-text.** Whisper is selected by default and labeled on-device/free.
→ If the binary/model aren't ready, a "Setup Whisper" button appears. Click it.
→ The button shows a **spinning loader** ("Building whisper.cpp…" then "Downloading base.en model (~142MB)…"), a progress bar fills, and it ends at "Setup Complete / Whisper is ready!". (Build needs `git`+`cmake`; download needs network.)

☐ Select **Groq** instead.
→ An API-key field appears. Selecting Whisper/macOS hides it.

☐ **Step 3 — Refinement.** Claude CLI is preselected.
→ Claude CLI / Codex CLI show "Installed" or "Not found" badges based on whether those CLIs are on PATH. Selecting **Ollama** reveals endpoint/model fields. **None** is selectable.

☐ **Step 4 — Project context (optional).** Click **Browse**, pick a code folder, click **Scan project**.
→ Button shows a spinner ("Scanning…"), the output box streams Claude's analysis, and it ends with "N chars of context generated". (Needs the `claude` CLI.) You can also **Skip**.

☐ Click **Get started** on the last step.
→ Onboarding window closes; it does not reappear on next launch.

☐ Navigate Back/Next through all steps.
→ Progress dots update (done = filled, current = highlighted); no console errors.

---

## 2. Permissions (re-checkable in Settings)

☐ Open the hub → **General** tab → **Permissions** card.
→ Shows live **Accessibility** and **Input Monitoring** status badges with "Open Accessibility" / "Open Input Monitoring" buttons.

☐ Toggle a permission off in System Settings, return to the window (click it to focus).
→ The badge refreshes on window focus (no manual reload). If anything is missing, the hint about quitting/reopening + "Press fn key → Do Nothing" is shown.

☐ Set **System Settings → Keyboard → "Press 🌐 fn key to" → "Do Nothing"**.
→ Prevents macOS from stealing `fn` for emoji/dictation.

---

## 3. Core dictation flow (the heart of the app)

> Requires: Accessibility + Input Monitoring granted, mic working, an STT engine ready, and (for fn) the app restarted after granting Input Monitoring.

☐ Put the cursor in any text field (Notes, browser, etc.). **Hold `fn`** and speak a sentence, then release.
→ The floating overlay appears (recording → transcribing → refining), and the refined text is typed at your cursor. A start/stop sound plays.

☐ **Double-tap `fn`** to start, speak, **single-tap `fn`** to stop.
→ Toggle-style recording works the same way.

☐ Press **`⌘⇧V`** (fallback hotkey) to toggle recording.
→ Works even if Input Monitoring isn't granted (this path uses Electron's global shortcut, not the event tap). Good fallback to confirm the pipeline independent of `fn`.

☐ Press **`⌘⇧B`**.
→ The floating overlay toggles visibility.

☐ Start recording and stay silent (with "Auto-stop on silence" enabled).
→ Recording auto-stops after the configured silence duration.

☐ Watch the overlay during a dictation.
→ States progress idle → recording (waveform reacts to your voice) → transcribing → refining → result; errors show a red state. Low-confidence words appear underlined.

---

## 4. Dictation intelligence

☐ **Sentence continuation.** Type "I went to the " and leave the cursor at the end (mid-sentence). Dictate "store to buy milk".
→ Output continues the sentence (lowercase start, correct spacing): "I went to the store to buy milk." Capitalized proper nouns / "I" / code identifiers are preserved.

☐ **Accent / dialect.** Dictate something with regional spelling/idioms (e.g. British "colour", "brilliant").
→ The refiner preserves your phrasing/spelling — it should not Americanize or rephrase your meaning.

☐ **Vocabulary biasing.** Add a term in **Dictionary** (e.g. a product name), then dictate a sentence using it.
→ The term is recognized/spelled correctly (it's fed to Whisper as a bias prompt and to the refiner).

☐ **Project jargon.** After scanning a project (Project tab), dictate using class/function names from it.
→ Those identifiers come out correctly spelled.

☐ **Voice commands.** Dictate "new line" / "new paragraph" / "scratch that" (with Voice commands enabled).
→ Commands are applied (line breaks inserted; the preceding phrase removed for "scratch that") rather than typed literally.

☐ **Self-correction.** Dictate "let's meet Monday no wait Tuesday".
→ Output is the corrected version: "Let's meet Tuesday."

☐ **No-LLM path.** Set LLM provider to **None**, then dictate.
→ Raw transcription is inserted, and continuation spacing/capitalization still works (it's deterministic).

---

## 5. Hub screens

### Home
☐ Open Home.
→ Time-based greeting (morning/afternoon/evening), a "Hold `fn` and speak" hero showing the current hotkey + an "on-device" chip, three stat tiles (total words, wpm, current streak), and recent dictations (or an empty-state message). Long dictation text wraps inside the card.

### Insights
☐ Open Insights.
→ Words-per-minute gauge (with typing-speed marker), fixes/dictations, total words, app-usage bars, a streak heatmap, and recent dictations. With zero data, values show "—"/0 and empty states (no leftover/stale gauge).

### Dictionary
☐ Add a term with term/context/misrecognitions/category, click Add.
→ It appears in the list with its category and "≠ misrecognitions". The **category you picked is saved** (verify by reopening — it should not all show as "product").
☐ Remove a term (✕).
→ It disappears. Empty state shows when the list is empty. Terms with HTML characters render as text (not interpreted).

### Project
☐ Browse + Scan a project (see onboarding step 4); also verify the **Current Context** preview shows saved context on reload.
→ Spinner during scan, streamed output, context persists and displays. Empty state when none.

### History
☐ Open History after a few dictations.
→ Each run shows timestamp, engine/provider/duration, raw + refined text. Special characters render as text.
☐ Type in the search box.
→ List filters to matches; clearing restores the full list.
☐ Click **Re-insert** on an entry.
→ That text is inserted at your current cursor.
☐ Click **Clear All**.
→ History empties (no crash if it fails).

---

## 6. Settings

### General
☐ Change the **Hotkey**, **Recording mode**, and **Start delay**, then quit and relaunch.
→ All three persist (Start Delay specifically — this was a fixed bug; confirm it survives a relaunch).
☐ Toggle Launch at login / Auto-stop on silence / Noise reduction / Whisper mode.
→ Each persists across relaunch.
☐ **STT engine** dropdown.
→ Whisper (on-device, free, recommended) is first; cloud engines labeled. Selecting Whisper reveals the model/build section; selecting a cloud engine hides it.
☐ Whisper **Build** / **Download** buttons.
→ Show spinners while running; status badges update ("Installed" / "Model ready").
☐ **Validate** a Groq/Deepgram/OpenAI key (with a real key).
→ Shows "valid" or an error message.
☐ Change **Transcription language** and **Audio input device**.
→ Persist; the device list is populated from the system.

### AI & Refinement
☐ Switch **LLM provider** and fill the relevant config (Ollama endpoint/model, API models, llama endpoint).
→ Each saves. Provider Health card shows per-provider status.
☐ **Templates (snippets):** add name/trigger/content, then dictate the trigger phrase.
→ Template appears in the list; dictating the trigger inserts the content. (Adding with an empty field is a no-op — fill all three.)
☐ Edit the **Refinement prompt** and **Vocabulary list**.
→ Persist; a staleness banner appears if your custom prompt predates the default.
☐ Toggle **Window context** + pick a Context provider; toggle **Grammar validation** and **Voice commands**.
→ Persist and affect refinement.

### Sidebar footer
☐ Click **Copy Logs**.
→ "Copied!" appears briefly; pasting elsewhere yields plain-text logs.

---

## 7. Tray & lifecycle

☐ Click the menu-bar tray icon.
→ Menu with recording toggle, Settings, Quit. Tray reflects state (idle/recording/etc.).
☐ Enable **Launch at login**, reboot (or re-login).
→ Echo starts automatically.
☐ Quit via tray while a recording/transcription is in flight.
→ App shuts down cleanly (force-stops recorder/monitors; no hung process).

---

## 8. Known limitations / not yet built

- **Tauri build** (`src-tauri`) is the non-running WIP port; it lacks the Input Monitoring wiring and `overlayDragMove`. Test on the **Electron** build (`npm start`) — that's the supported runtime.
- **Microphone** row in onboarding shows "Will prompt" (there's no live mic-permission check); macOS prompts on first record.
- Not built yet (mockups only): the Wispr-Flow "Your voice" Insights tab and the Snippets/Style/Transforms/Scratchpad nav. Today those map to existing places: Snippets → AI & Refinement ▸ Templates; Style → AI & Refinement ▸ Refinement prompt/tone; Transforms → AI & Refinement ▸ Voice commands.

---

## What I fixed during this pass (so you can spot-check)

- **Start Delay now persists** (was missing from the settings auto-save list).
- **Output escaping** in History, Templates, and the overlay's low-confidence transcript (so speech/text containing `<`, `&`, etc. renders literally).
- **Defensive guards** so a missing element can't abort hub initialization (Dictionary add, Project scan/browse, Clear history).
- **WPM gauge** clears correctly when there's no data (no stale marker).
- **No duplicate Whisper downloads** after an in-app model download (was re-attaching listeners).
- **Consistent spinners** on every long action (onboarding scan, hub scan, Whisper build/download).
- **Permissions surfaced in Settings → General**, not just onboarding.
