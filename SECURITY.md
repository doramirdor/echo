# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Echo, please report it privately.
**Do not open a public issue for security problems.**

- Use GitHub's [private vulnerability reporting](https://github.com/doramirdor/echo-tauri/security/advisories/new), or
- Email **amirdor@gmail.com** with the details.

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (proof of concept if possible)
- Affected version(s) and platform

You can expect an initial response within a few days. We'll keep you updated as
we work on a fix and will credit you in the release notes unless you prefer to
remain anonymous.

## Scope

Echo is a local-first macOS app. Areas of particular interest:

- Handling of API keys and credentials stored in settings
- Text insertion via the Accessibility API and AppleScript
- The Swift helper binaries compiled at runtime
- Any path where audio, transcripts, or screenshots could leak to an unintended
  destination

## What Echo does with your data

By default, Echo runs **fully offline** (local Whisper + no LLM). Network calls
only happen when you explicitly choose a cloud STT or LLM provider. See
[docs/PRIVACY.md](docs/PRIVACY.md) for the exact data-flow per provider.
