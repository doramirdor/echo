#!/usr/bin/env bash
#
# Build a SHAREABLE Echo.app/.dmg that needs no developer tools on the
# recipient's Mac — no Xcode tools, no Homebrew, no git/cmake.
#
# It stages prebuilt native helpers + whisper-cli into src-tauri/bin (bundled as
# app resources), then runs the Tauri build. The app seeds those into
# ~/Library/Application Support/echo on first launch (see
# src-tauri/src/utils/provision.rs).
#
# The Whisper MODEL (~142MB) is deliberately NOT bundled — it's downloaded once
# on first launch from onboarding (Setup Whisper), keeping the .dmg small. So the
# recipient DOES need internet on first run to fetch the model.
#
# Run this on YOUR Mac (the builder). You need: Rust, Xcode Command Line Tools
# (swiftc), cmake + git (only to build whisper-cli the first time), and Node.
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
HELPERS=(fn-monitor live-transcribe transcribe field-context record text-insert)

echo "==> Staging into $BIN_OUT"
mkdir -p "$BIN_OUT"
# The model is downloaded on first launch, not bundled. Clear any model left in
# the staging dir by an older build so it can't get picked up as a resource.
rm -rf "$MODELS_OUT"

echo "==> Compiling Swift helpers (host arch)…"
for h in "${HELPERS[@]}"; do
  swiftc -O -o "$BIN_OUT/$h" "scripts/${h}.swift"
  echo "    ✓ $h"
done

echo "==> Ensuring whisper-cli is built (one-time)…"
if [ ! -x "$SUPPORT/bin/whisper-cli" ]; then
  bash scripts/setup-whisper.sh
fi
cp "$SUPPORT/bin/whisper-cli" "$BIN_OUT/whisper-cli"
chmod +x "$BIN_OUT"/*
echo "    ✓ whisper-cli staged (model downloads on first launch)"

echo "==> Building the app (cargo tauri build)…"
npm run build

DMG_DIR="src-tauri/target/release/bundle/dmg"
echo ""
echo "==> Done. Share the .dmg in: $DMG_DIR"
ls -1 "$DMG_DIR"/*.dmg 2>/dev/null || true
echo ""
echo "Send your friend the .dmg + the install steps in SHARE.md."
