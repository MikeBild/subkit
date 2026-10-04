#!/usr/bin/env bash

set -euo pipefail

main() {
  local REPO="mikebild/subkit"
  local INSTALL_DIR="${SUBKIT_INSTALL_DIR:-$HOME/.subkit/bin}"

  local OS ARCH
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  case "$OS" in
    darwin) OS="darwin" ;;
    linux)  OS="linux" ;;
    *)      echo "error: unsupported OS: $OS"; exit 1 ;;
  esac
  case "$ARCH" in
    x86_64|amd64)  ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *)             echo "error: unsupported architecture: $ARCH"; exit 1 ;;
  esac

  echo "Fetching latest release..."
  local LATEST
  LATEST=$(curl --retry 3 --retry-delay 2 -fsSL \
    "https://api.github.com/repos/$REPO/releases/latest" \
    | grep '"tag_name"' | cut -d'"' -f4)
  if [ -z "$LATEST" ]; then
    echo "error: could not determine latest release"; exit 1
  fi
  echo "Installing subkit $LATEST for ${OS}/${ARCH}..."

  mkdir -p "$INSTALL_DIR"
  local TMP_DIR
  TMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TMP_DIR"' EXIT

  local BINARY ASSET URL
  for BINARY in sk subkit; do
    ASSET="${BINARY}_${OS}_${ARCH}"
    URL="https://github.com/$REPO/releases/download/$LATEST/$ASSET"
    echo "  downloading $ASSET..."
    curl --retry 3 --retry-delay 2 -fSL --progress-bar \
      -o "$TMP_DIR/$ASSET" "$URL"

    if [ ! -s "$TMP_DIR/$ASSET" ]; then
      echo "error: downloaded $ASSET is empty"; exit 1
    fi
  done

  echo "  downloading SHA256SUMS..."
  curl --retry 3 --retry-delay 2 -fsSL \
    -o "$TMP_DIR/SHA256SUMS" \
    "https://github.com/$REPO/releases/download/$LATEST/SHA256SUMS"

  if [ ! -s "$TMP_DIR/SHA256SUMS" ]; then
    echo "error: SHA256SUMS is empty"; exit 1
  fi

  echo "Verifying checksums..."
  local EXPECTED ACTUAL
  for BINARY in sk subkit; do
    ASSET="${BINARY}_${OS}_${ARCH}"
    EXPECTED=$(grep "$ASSET" "$TMP_DIR/SHA256SUMS" | awk '{print $1}')
    if [ -z "$EXPECTED" ]; then
      echo "error: no checksum found for $ASSET"; exit 1
    fi
    if command -v sha256sum >/dev/null 2>&1; then
      ACTUAL=$(sha256sum "$TMP_DIR/$ASSET" | awk '{print $1}')
    else
      ACTUAL=$(shasum -a 256 "$TMP_DIR/$ASSET" | awk '{print $1}')
    fi
    if [ "$EXPECTED" != "$ACTUAL" ]; then
      echo "error: checksum mismatch for $ASSET"
      echo "  expected: $EXPECTED"
      echo "  actual:   $ACTUAL"
      exit 1
    fi
  done
  echo "Checksums verified."

  for BINARY in sk subkit; do
    ASSET="${BINARY}_${OS}_${ARCH}"
    chmod 755 "$TMP_DIR/$ASSET"
    mv "$TMP_DIR/$ASSET" "$INSTALL_DIR/$BINARY"
  done

  if [ "$OS" = "darwin" ]; then
    echo "Signing binaries (macOS)..."
    for BINARY in sk subkit; do
      codesign --remove-signature "$INSTALL_DIR/$BINARY" 2>/dev/null || true
      codesign --sign - --force "$INSTALL_DIR/$BINARY"
    done
  fi

  echo ""
  echo "Installed sk and compatibility alias subkit to $INSTALL_DIR"

  if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    local SHELL_NAME RC
    SHELL_NAME=$(basename "${SHELL:-sh}")
    case "$SHELL_NAME" in
      zsh)  RC="$HOME/.zshrc" ;;
      bash) RC="$HOME/.bashrc" ;;
      *)    RC="$HOME/.profile" ;;
    esac
    echo ""
    echo "Add to your PATH by running:"
    echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> $RC"
    echo "  source $RC"
  fi

  echo ""
  echo "Run 'sk --version' to verify the installation."
  echo "Run 'sk update' at any time to update to the latest version."
}

main "$@"
