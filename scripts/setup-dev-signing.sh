#!/usr/bin/env bash
#
# setup-dev-signing.sh — create a self-signed "Echo" code-signing identity for
# the DEV build.
#
# Why: in dev, the helper binaries (fn-monitor, text-insert, record, …) are
# ad-hoc signed. macOS keys TCC grants for ad-hoc code by cdhash, so each helper
# shows up under its own name in Privacy & Security (Input Monitoring shows
# "fn-monitor", Accessibility shows "text-insert", etc.) and the grants drift on
# every rebuild.
#
# With a real (self-signed) certificate, macOS keys the grant on the signing
# identity (identifier + cert) instead of cdhash. Signing every helper under one
# shared identity collapses them into a single "Echo" entry per permission list,
# and the grant survives rebuilds. See codesign_stable() in
# src-tauri/src/utils/swift_binary.rs, which picks up this identity automatically
# when present and falls back to ad-hoc when it isn't (CI, fresh machines).
#
# Idempotent: safe to re-run. This only affects your local dev machine; packaged
# builds are signed once at bundle time and already show a single "Echo".

set -euo pipefail

CN="Echo"                                  # cert Common Name = what Privacy shows
KEYCHAIN="echo-dev.keychain"
KEYCHAIN_DB="$HOME/Library/Keychains/${KEYCHAIN}-db"
KC_PASS="echo-dev"                          # password of a keychain WE own → non-interactive

if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$CN\""; then
  echo "✓ '$CN' code-signing identity already present — nothing to do."
  security find-identity -v -p codesigning | grep "\"$CN\"" || true
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Creating self-signed '$CN' code-signing certificate…"

cat > "$WORK/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $CN
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/openssl.cnf" >/dev/null 2>&1

# Legacy PBE/MAC so macOS `security import` can read the bundle across OpenSSL/LibreSSL.
openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -out "$WORK/echo.p12" -passout pass:"$KC_PASS" -name "$CN" \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg SHA1 >/dev/null 2>&1

# Dedicated keychain whose password we set → codesign can use the key without
# an interactive keychain prompt.
security delete-keychain "$KEYCHAIN" 2>/dev/null || true
security create-keychain -p "$KC_PASS" "$KEYCHAIN"
security set-keychain-settings "$KEYCHAIN"          # disable auto-lock timeout
security unlock-keychain -p "$KC_PASS" "$KEYCHAIN"

# Keep the existing search list and append ours so codesign finds the identity.
EXISTING=$(security list-keychains -d user | sed -e 's/[",]//g' | xargs)
security list-keychains -d user -s $EXISTING "$KEYCHAIN_DB"

security import "$WORK/echo.p12" -k "$KEYCHAIN_DB" -P "$KC_PASS" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KC_PASS" "$KEYCHAIN_DB" >/dev/null 2>&1

echo "✓ '$CN' identity created."
security find-identity -v -p codesigning | grep "\"$CN\"" || {
  echo "⚠️  Identity not found after import — check the output above." >&2
  exit 1
}
echo
echo "Next: rebuild/restart the app. The helpers will re-sign as '$CN' and you'll"
echo "re-grant each permission once (Input Monitoring, Accessibility, Microphone),"
echo "after which they'll persist as a single \"Echo\" entry."
