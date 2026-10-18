#!/usr/bin/env bash

set -euo pipefail

main() (
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
  LATEST=$(curl --proto '=https' --proto-redir '=https' --retry 3 --retry-delay 2 -fsSL \
    "https://api.github.com/repos/$REPO/releases/latest" \
    | grep '"tag_name"' | cut -d'"' -f4)
  if [[ ! "$LATEST" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "error: could not determine latest release"; exit 1
  fi
  echo "Installing subkit $LATEST for ${OS}/${ARCH}..."

  local TMP_DIR
  TMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TMP_DIR"' EXIT

  local ASSET="sk_${OS}_${ARCH}"
  local FILE
  for FILE in "$ASSET" LICENSE THIRD_PARTY_NOTICES.txt SHA256SUMS SHA256SUMS.sig; do
    echo "  downloading $FILE..."
    curl --proto '=https' --proto-redir '=https' --retry 3 --retry-delay 2 -fsSL \
      -o "$TMP_DIR/$FILE" "https://github.com/$REPO/releases/download/$LATEST/$FILE"
    if [ ! -s "$TMP_DIR/$FILE" ]; then
      echo "error: downloaded $FILE is empty"; exit 1
    fi
  done

  cat > "$TMP_DIR/release-public-key.pem" <<'PUBLIC_KEY'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAyF3lL39nLly5M13CruFCrfZJfJiCcvlyJi/ZeTIhe/U=
-----END PUBLIC KEY-----
PUBLIC_KEY
  if ! openssl pkeyutl -verify -pubin -inkey "$TMP_DIR/release-public-key.pem" \
    -rawin -in "$TMP_DIR/SHA256SUMS" -sigfile "$TMP_DIR/SHA256SUMS.sig"; then
    echo "error: release signature verification failed; OpenSSL with Ed25519 support is required" >&2
    exit 1
  fi

  local EXPECTED ACTUAL
  for FILE in "$ASSET" LICENSE THIRD_PARTY_NOTICES.txt; do
    EXPECTED=$(awk -v asset="$FILE" '$2 == asset { print $1 }' "$TMP_DIR/SHA256SUMS")
    if [[ ! "$EXPECTED" =~ ^[a-fA-F0-9]{64}$ ]]; then
      echo "error: missing, duplicate or invalid checksum for $FILE" >&2
      exit 1
    fi
    if command -v sha256sum >/dev/null 2>&1; then
      ACTUAL=$(sha256sum "$TMP_DIR/$FILE" | awk '{print $1}')
    else
      ACTUAL=$(shasum -a 256 "$TMP_DIR/$FILE" | awk '{print $1}')
    fi
    if [ "$EXPECTED" != "$ACTUAL" ]; then
      echo "error: checksum mismatch for $FILE" >&2
      exit 1
    fi
  done
  echo "Signature and checksum verified."

  chmod 755 "$TMP_DIR/$ASSET"
  if [ "$OS" = "darwin" ]; then
    echo "Signing binary (macOS)..."
    codesign --remove-signature "$TMP_DIR/$ASSET" 2>/dev/null || true
    codesign --sign - --force "$TMP_DIR/$ASSET"
  fi

  if [ -d "$INSTALL_DIR/sk" ] || [ -d "$INSTALL_DIR/subkit" ] || \
    [ -d "$INSTALL_DIR/subkit.LICENSE" ] || [ -d "$INSTALL_DIR/subkit.THIRD_PARTY_NOTICES.txt" ]; then
    echo "error: installation targets must not be directories" >&2
    exit 1
  fi
  mkdir -p "$INSTALL_DIR"
  local STAGED
  STAGED=$(mktemp "$INSTALL_DIR/.sk.XXXXXXXX")
  trap 'rm -rf "$TMP_DIR"; rm -f "$STAGED"' EXIT
  for FILE in LICENSE THIRD_PARTY_NOTICES.txt; do
    cp "$TMP_DIR/$FILE" "$STAGED"
    chmod 644 "$STAGED"
    mv -f "$STAGED" "$INSTALL_DIR/subkit.$FILE"
    STAGED=$(mktemp "$INSTALL_DIR/.sk.XXXXXXXX")
  done
  cp "$TMP_DIR/$ASSET" "$STAGED"
  chmod 755 "$STAGED"
  mv -f "$STAGED" "$INSTALL_DIR/sk"
  ln -sfn sk "$INSTALL_DIR/subkit"

  echo ""
  echo "Installed sk and compatibility alias subkit to $INSTALL_DIR"
  echo "License notices: $INSTALL_DIR/subkit.LICENSE and $INSTALL_DIR/subkit.THIRD_PARTY_NOTICES.txt"

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
)

main "$@"
