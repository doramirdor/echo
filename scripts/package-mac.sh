#!/usr/bin/env bash
#
# Build a SHAREABLE Echo.app/.dmg that needs nothing on the recipient's Mac —
# no Xcode tools, no Homebrew, no git/cmake, no network on first run.
#
# It stages prebuilt native helpers + whisper-cli + the Whisper model into
# src-tauri/{bin,models} (bundled as app resources), then runs the Tauri build.
# The app seeds those into ~/Library/Application Support/echo on first launch
# (see src-tauri/src/utils/provision.rs).
#
# Run this on YOUR Mac (the builder). You need: Rust, Xcode Command Line Tools
# (swiftc), cmake + git (only to build whisper the first time), and Node.
#
# Usage:  bash scripts/package-mac.sh
#
# NOTE: this produces a build for YOUR Mac's chip (Apple Silicon or Intel). It
# runs on a friend with the same chip. For a universal build, use the GitHub
# release workflow (.github/workflows/release.yml) instead.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SUPPORT="$HOME/Library/Application Support/echo"
BIN_OUT="src-tauri/bin"
MODELS_OUT="src-tauri/models"
MODEL="ggml-base.en.bin"
HELPERS=(fn-monitor live-transcribe transcribe field-context record)

echo "==> Staging into $BIN_OUT and $MODELS_OUT"
mkdir -p "$BIN_OUT" "$MODELS_OUT"

echo "==> Compiling Swift helpers (host arch)…"
for h in "${HELPERS[@]}"; do
  swiftc -O -o "$BIN_OUT/$h" "scripts/${h}.swift"
  echo "    ✓ $h"
done

echo "==> Ensuring whisper-cli + model are built (one-time)…"
if [ ! -x "$SUPPORT/bin/whisper-cli" ] || [ ! -f "$SUPPORT/models/$MODEL" ]; then
  bash scripts/setup-whisper.sh
fi
cp "$SUPPORT/bin/whisper-cli" "$BIN_OUT/whisper-cli"
cp "$SUPPORT/models/$MODEL" "$MODELS_OUT/$MODEL"
chmod +x "$BIN_OUT"/*
echo "    ✓ whisper-cli + $MODEL staged"

echo "==> Building the app (cargo tauri build)…"
npm run build

DMG_DIR="src-tauri/target/release/bundle/dmg"
echo ""
echo "==> Done. Share the .dmg in: $DMG_DIR"
ls -1 "$DMG_DIR"/*.dmg 2>/dev/null || true
echo ""
echo "Send your friend the .dmg + the install steps in SHARE.md."
