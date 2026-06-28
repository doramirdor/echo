# Echo User Guide

Echo is a macOS menu-bar voice dictation app that records speech, transcribes it, refines with AI, and types the result into your active application.

## Installation

### From Source (Developers)

```bash
brew install sox
cd echo
npm install
npm run setup    # Build local Whisper (optional)
npm start
```

### Permissions

On first launch, Echo will guide you through:

1. **Microphone** — required for recording
2. **Accessibility** — required to insert text into other apps
3. **Speech Recognition** — required for live transcription (macOS STT)

## Recording

| Method | Action |
|--------|--------|
| **fn key (hold)** | Hold fn to record, release to stop |
| **fn key (double-tap)** | Toggle recording on/off |
| **fn key (single-tap)** | Stop toggle recording |
| **Hotkey** (default `⌘⇧V`) | Toggle or hold-to-talk (per Settings) |
| **Overlay click** | Toggle recording |
| **Tray menu** | Start/stop recording |
| **Esc** | Cancel recording |

## Settings Overview

### General

- **Recording Mode** — Toggle (press to start/stop) or Hold (hold keys to record)
- **Start Delay** — Milliseconds before recording begins (prevents accidental triggers)
- **Silence Detection** — Auto-stop after period of silence
- **STT Engine** — Choose transcription backend
- **Transcription Language** — Language for STT (or auto-detect)

### LLM

- **Provider** — Claude CLI, Codex CLI, Claude API, OpenAI API, Ollama, Llama.cpp, or None
- **Grammar Check** — Second pass for grammar/punctuation
- **Voice Commands** — "new line", "scratch that", etc.
- **Templates** — Voice-triggered text snippets

### Memory

Add vocabulary entries so Echo learns your terms:

- **Term** — Correct spelling (e.g., "React")
- **Misrecognitions** — What STT gets wrong (e.g., "react, re act")

Echo also auto-learns corrections after 3 consistent matches.

### History

Search and re-insert past dictations from the History tab.

## Voice Commands

| Command | Result |
|---------|--------|
| "new line" | Line break |
| "new paragraph" | Paragraph break |
| "period" | `.` |
| "comma" | `,` |
| "scratch that" | Cancel (skip refinement) |
| "undo that" | Cancel (skip refinement) |

## Templates

Create templates triggered by voice:

- **Name:** Email Signature
- **Trigger:** "type my email signature"
- **Content:** Best regards,\nYour Name

## Troubleshooting

| Problem | Solution |
|---------|----------|
| SoX not found | `brew install sox` |
| Whisper not ready | Settings → build binary + download model |
| Accessibility denied | System Settings → Privacy → Accessibility → Echo |
| Groq/API errors | Validate API key in Settings |
| Ollama not running | `ollama serve` |
| No speech detected | Check microphone, speak closer |

### Copy Logs

Settings → General → **Copy Logs** for bug reports.

## Provider Health

Settings → LLM → **Provider Health** shows status of all configured backends.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `⌘⇧V` | Record (default hotkey) |
| `⌘⇧B` | Toggle overlay |
| `Esc` | Cancel recording |
| `fn` (hold) | Hold-to-talk |

## Fully Offline Setup

1. STT Engine → Local Whisper.cpp
2. Build Whisper binary + download model in Settings
3. LLM Provider → Llama.cpp or None
4. Disable window context and screenshots

See [PRIVACY.md](PRIVACY.md) for data handling details.
