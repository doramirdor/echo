#!/bin/bash
set -e

APP_SUPPORT="$HOME/Library/Application Support/echo"
BIN_DIR="$APP_SUPPORT/bin"
MODELS_DIR="$APP_SUPPORT/models"
TMP_DIR="/tmp/echo-setup"
MODEL_NAME="ggml-base.en.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_NAME"

echo "=== Echo Setup ==="
echo ""

# 1. Check for dependencies
for dep in rec cmake; do
  if command -v "$dep" &>/dev/null; then
    echo "✓ $dep is installed"
  else
    pkg="$dep"
    [ "$dep" = "rec" ] && pkg="sox"
    echo "✗ $dep not found. Installing $pkg via Homebrew..."
    brew install "$pkg"
  fi
done

# 2. Build whisper.cpp
echo ""
echo "--- Building whisper.cpp ---"
mkdir -p "$TMP_DIR"
mkdir -p "$BIN_DIR"

if [ -f "$BIN_DIR/whisper-cli" ]; then
  echo "✓ whisper-cli binary already exists at $BIN_DIR/whisper-cli"
else
  cd "$TMP_DIR"
  if [ ! -d "whisper.cpp" ]; then
    echo "Cloning whisper.cpp..."
    git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git
  fi
  cd whisper.cpp
  echo "Building..."
  cmake -B build -DCMAKE_BUILD_TYPE=Release
  cmake --build build --config Release -j$(sysctl -n hw.ncpu)
  cp build/bin/whisper-cli "$BIN_DIR/whisper-cli"
  echo "✓ Built and installed whisper-cli to $BIN_DIR/"
fi

# 3. Download model
echo ""
echo "--- Downloading Whisper model ---"
mkdir -p "$MODELS_DIR"

if [ -f "$MODELS_DIR/$MODEL_NAME" ]; then
  echo "✓ Model already exists at $MODELS_DIR/$MODEL_NAME"
else
  echo "Downloading $MODEL_NAME (~142MB)..."
  curl -L -o "$MODELS_DIR/$MODEL_NAME" "$MODEL_URL" --progress-bar
  echo "✓ Model downloaded to $MODELS_DIR/$MODEL_NAME"
fi

# 4. Summary
echo ""
echo "=== Setup Complete ==="
echo "Binary: $BIN_DIR/whisper-cli"
echo "Model:  $MODELS_DIR/$MODEL_NAME"
echo ""
echo "Run 'npm start' to launch Echo!"
