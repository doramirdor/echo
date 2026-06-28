# Echo Privacy Guide

Echo is designed with privacy in mind. This document describes what data leaves your machine for each configuration.

## Fully Offline Mode

Configure Echo for zero network calls:

- **STT Engine:** Local Whisper.cpp
- **LLM Provider:** None (raw transcription) or Llama.cpp (local)
- **Window Context:** Disabled
- **Screenshots:** Disabled

In this mode, all audio processing happens on your Mac. No data is sent to external services.

## Data by Provider

| Provider | Data Sent | Stored By Provider |
|----------|-----------|-------------------|
| Local Whisper | Nothing (on-device) | N/A |
| macOS STT | Nothing (on-device) | N/A |
| Groq Cloud | Audio file | Per Groq privacy policy |
| Deepgram | Audio file | Per Deepgram privacy policy |
| OpenAI Whisper | Audio file | Per OpenAI privacy policy |
| Claude CLI | Transcription text | Per Anthropic policy |
| Codex CLI | Transcription text | Per OpenAI policy |
| Claude API | Transcription text + context | Per Anthropic policy |
| OpenAI API | Transcription text + context | Per OpenAI policy |
| Ollama (local) | Nothing (localhost) | N/A |
| Llama.cpp (local) | Nothing (localhost) | N/A |
| Claude Vision | Screenshot + window metadata | Per Anthropic policy |
| Groq Vision | Screenshot + window metadata | Per Groq privacy policy |

## Local Data Storage

Echo stores the following on your Mac only:

- `~/Library/Application Support/echo/settings.json` — app preferences
- `~/Library/Application Support/echo/memory.json` — vocabulary entries
- `~/Library/Application Support/echo/run-log.json` — last 100 dictation runs
- `~/Library/Application Support/echo/logs/echo.log` — diagnostic logs
- `~/Library/Application Support/echo/templates.json` — voice templates
- `~/Library/Application Support/echo/project-context.md` — scanned project context

## Permissions

| Permission | Why |
|------------|-----|
| Microphone | Record voice for transcription |
| Accessibility | Insert text into other applications |
| Speech Recognition | Live transcription via macOS STT |

## Crash Reporting

Crash reporting is **disabled by default**. When enabled, error logs may be sent to a configured endpoint. No audio or transcription content is included.

## Recommendations

1. Use local Whisper + local LLM for maximum privacy
2. Disable screenshot capture unless needed
3. Clear run history periodically from Settings → History
4. Review vocabulary memory entries in Settings → Memory
