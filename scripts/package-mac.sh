#!/usr/bin/env bash
#
# Build a SHAREABLE Echo.app/.dmg that needs no developer tools on the
# recipient's Mac — no Xcode tools, no Homebrew, no git/cmake.
#
# It stages prebuilt native helpers + whisper-cli + parakeet-cli into
# src-tauri/bin (bundled as app resources), then runs the Tauri build. The app
# seeds those into ~/Library/Application Support/echo on first launch (see
# src-tauri/src/utils/provision.rs).
#
# The MODELS are deliberately NOT bundled — Whisper's (~142MB) is downloaded once
# on first launch from onboarding (Setup Whisper), and Parakeet's (~900MB) only
# if the recipient opts into that engine. This keeps the .dmg small, but the
# recipient DOES need internet on first run.
#
# Run this on YOUR Mac (the builder). You need: Rust, Xcode Command Line Tools
# (swiftc), cmake + git (to build whisper-cli / parakeet-cli), and Node.
#
# Usage:  bash scripts/package-mac.sh
#         ECHO_SKIP_PARAKEET=1 bash scripts/package-mac.sh   # omit parakeet-cli
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
echo "    ✓ whisper-cli staged (model downloads on first launch)"

# parakeet-cli powers the opt-in `parakeet` STT engine. Bundling it means a
# recipient who switches engines doesn't need git/cmake to build it themselves.
# Set ECHO_SKIP_PARAKEET=1 to leave it out (faster packaging; the engine then
# still works, but only after the recipient builds the binary from Settings).
if [ "${ECHO_SKIP_PARAKEET:-0}" = "1" ]; then
  echo "==> Skipping parakeet-cli (ECHO_SKIP_PARAKEET=1)"
  rm -f "$BIN_OUT/parakeet-cli"
else
  echo "==> Building parakeet-cli for distribution…"
  # Built here rather than copied from "$SUPPORT/bin" on purpose: the copy there
  # (if any) was compiled by the app's own build-from-Settings path, which
  # targets the local machine. This build has to run on someone else's.
  PARAKEET_TMP="/tmp/echo-parakeet-package"
  mkdir -p "$PARAKEET_TMP"
  if [ ! -d "$PARAKEET_TMP/parakeet.cpp" ]; then
    git clone --depth 1 --recursive https://github.com/mudler/parakeet.cpp "$PARAKEET_TMP/parakeet.cpp"
  fi
  (
    cd "$PARAKEET_TMP/parakeet.cpp"
    # Every flag here exists to make ONE self-contained, portable binary — we
    # copy just parakeet-cli out, with nothing beside it:
    #
    #   BUILD_SHARED_LIBS=OFF   Default ON links parakeet-cli against five
    #                           @rpath/libggml*.dylib files that live in this
    #                           build dir. Copying the binary alone then ships
    #                           something that dies with "Library not loaded" on
    #                           the recipient's Mac. Static = one file that runs.
    #   GGML_NATIVE=OFF         parakeet.cpp forces this ON, compiling with
    #                           -march=native. Built on an M5 that binary can
    #                           SIGILL on a friend's M1. OFF = portable arm64
    #                           baseline. Slower, but it runs everywhere.
    #   METAL_EMBED_LIBRARY=ON  Keeps the Metal shaders inside the binary, so
    #                           there's no .metallib to stage. (ggml already
    #                           defaults this ON with Metal; pinned so an
    #                           upstream default change can't silently break us.)
    #   BUILD_SERVER=OFF        Echo drives parakeet through the CLI only.
    cmake -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DPARAKEET_GGML_METAL=ON \
      -DGGML_METAL_EMBED_LIBRARY=ON \
      -DGGML_NATIVE=OFF \
      -DPARAKEET_BUILD_SERVER=OFF \
      -DPARAKEET_BUILD_TESTS=OFF
    cmake --build build --config Release -j"$(sysctl -n hw.ncpu)"
  )
  BUILT_PARAKEET="$PARAKEET_TMP/parakeet.cpp/build/examples/cli/parakeet-cli"
  if [ ! -x "$BUILT_PARAKEET" ]; then
    echo "!!  parakeet-cli build produced no binary at $BUILT_PARAKEET" >&2
    echo "    Re-run with ECHO_SKIP_PARAKEET=1 to package without it." >&2
    exit 1
  fi
  cp "$BUILT_PARAKEET" "$BIN_OUT/parakeet-cli"

  # A binary that needs a dylib from the build dir looks perfectly fine here and
  # dies on the recipient's Mac, so assert self-containment rather than trust the
  # flags: nothing outside /usr/lib and /System may be linked.
  if otool -L "$BIN_OUT/parakeet-cli" | tail -n +2 | awk '{print $1}' \
       | grep -qv -e '^/usr/lib/' -e '^/System/'; then
    echo "!!  parakeet-cli links non-system libraries — it will not run on another Mac:" >&2
    otool -L "$BIN_OUT/parakeet-cli" | tail -n +2 | awk '{print "      " $1}' \
      | grep -v -e '/usr/lib/' -e '/System/' >&2
    echo "    Expected a static build (-DBUILD_SHARED_LIBS=OFF)." >&2
    exit 1
  fi
  echo "    ✓ parakeet-cli staged, self-contained (model downloads on first launch)"
fi

chmod +x "$BIN_OUT"/*

echo "==> Building the app (cargo tauri build)…"
npm run build

DMG_DIR="src-tauri/target/release/bundle/dmg"
echo ""
echo "==> Done. Share the .dmg in: $DMG_DIR"
ls -1 "$DMG_DIR"/*.dmg 2>/dev/null || true
echo ""
echo "Send your friend the .dmg + the install steps in SHARE.md."
