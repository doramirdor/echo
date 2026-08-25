#!/usr/bin/env bash
#
# build-signed.sh — build the local packaged app signed with the self-signed
# "Echo" identity, so TCC grants survive rebuilds.
#
# Why: tauri.conf.json sets `signingIdentity: "-"` (ad-hoc). macOS keys a TCC
# grant on the code's designated requirement, and an ad-hoc requirement pins the
# cdhash — which changes on every build. So Input Monitoring / Accessibility die
# on each rebuild and have to be re-granted by hand.
#
# Signing with the "Echo" cert from setup-dev-signing.sh instead yields:
#   designated => identifier "com.echo.app" and certificate leaf = H"<cert>"
# No cdhash, so the grant sticks across rebuilds.
#
# This does NOT change tauri.conf.json: the committed "-" stays the default for
# CI and for scripts/package-mac.sh (the shareable build). A build for someone
# else must stay ad-hoc — recipients don't trust this cert, and its private key
# only exists on this machine. This path is for the local /Applications copy.
#
# Usage:
#   bash scripts/build-signed.sh              # build only
#   bash scripts/build-signed.sh --install    # build + replace /Applications/Echo.app

set -euo pipefail

CN="Echo"
KEYCHAIN_DB="$HOME/Library/Keychains/echo-dev.keychain-db"
KC_PASS="echo-dev"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILT_APP="$REPO_ROOT/src-tauri/target/release/bundle/macos/Echo.app"

cd "$REPO_ROOT"

# Match the CN exactly. `codesign --sign Echo` does substring matching and would
# be ambiguous with other certs on this machine (e.g. "Echo Dev Signing"), so
# resolve to the 40-hex SHA-1 and sign with that. Same approach as
# echo_signing_hash() in src-tauri/src/utils/swift_binary.rs.
#
# Note: `find-identity -v` filters to *trusted* certs and will never list a
# self-signed one, so this deliberately omits -v. codesign signs with an
# untrusted cert fine.
find_identity_hash() {
  security find-identity -p codesigning 2>/dev/null | awk -v cn="\"$CN\"" '
    $3 == cn && $2 ~ /^[0-9A-Fa-f]{40}$/ { print $2; exit }
  '
}

HASH="$(find_identity_hash || true)"

if [ -z "$HASH" ]; then
  echo "No '$CN' code-signing identity found." >&2
  echo "Run: bash scripts/setup-dev-signing.sh" >&2
  echo "(then re-run this script)" >&2
  exit 1
fi

# codesign can't reach the private key while the keychain is locked. It locks on
# reboot, so unlock every time rather than assuming.
security unlock-keychain -p "$KC_PASS" "$KEYCHAIN_DB"

echo "Building with identity '$CN' ($HASH)…"

# APPLE_SIGNING_IDENTITY overrides bundle.macOS.signingIdentity from the config,
# which leaves the committed "-" intact for every other build path.
#
# `tauri build` exits non-zero on the updater step when TAURI_SIGNING_PRIVATE_KEY
# is unset, but that runs *after* the .app is bundled and signed. Tolerate it and
# verify the bundle below instead.
set +e
APPLE_SIGNING_IDENTITY="$HASH" npx tauri build --bundles app
set -e

if [ ! -d "$BUILT_APP" ]; then
  echo "Build produced no app at $BUILT_APP" >&2
  exit 1
fi

# Fail loudly rather than silently shipping an ad-hoc bundle — an ad-hoc build
# still runs, it just quietly resurrects the permission drift this script exists
# to prevent.
#
# Capture first, then match. Piping straight into `grep -q` under `pipefail` is a
# false negative waiting to happen: grep exits at the first match, codesign takes
# SIGPIPE, and pipefail reports the whole pipeline as failed.
SIG_INFO="$(codesign -dv --verbose=2 "$BUILT_APP" 2>&1 || true)"
if ! printf '%s\n' "$SIG_INFO" | grep -q "Authority=$CN"; then
  echo "Built app is not signed as '$CN' — permissions would drift again." >&2
  printf '%s\n' "$SIG_INFO" | grep -E "Authority|Signature" >&2
  exit 1
fi

echo
echo "Designated requirement (what TCC binds the grant to):"
codesign -d -r- "$BUILT_APP" 2>&1 | grep "designated"

if [ "${1:-}" = "--install" ]; then
  echo
  echo "Installing to /Applications/Echo.app…"
  pkill -f "/Applications/Echo.app/Contents/MacOS/echo" 2>/dev/null || true
  pkill -f "Application Support/echo/bin/fn-monitor" 2>/dev/null || true
  sleep 1
  rm -rf /Applications/Echo.app
  cp -R "$BUILT_APP" /Applications/Echo.app
  echo "Installed."
fi
