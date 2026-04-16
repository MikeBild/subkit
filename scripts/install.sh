#!/usr/bin/env bash
# Install sk and subkit CLI binaries from the latest GitHub Release.
# Usage: curl -fsSL https://raw.githubusercontent.com/mikebild/subkit/main/scripts/install.sh | bash
set -euo pipefail

REPO="mikebild/subkit"
INSTALL_DIR="${SUBKIT_INSTALL_DIR:-$HOME/.subkit/bin}"

# ── Detect platform ──

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

# ── Fetch latest release tag ──

echo "Fetching latest release..."
LATEST=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
if [ -z "$LATEST" ]; then
  echo "error: could not determine latest release"; exit 1
fi
echo "Installing subkit $LATEST for ${OS}/${ARCH}..."

# ── Download binaries + checksums ──

mkdir -p "$INSTALL_DIR"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

for BINARY in sk subkit; do
  ASSET="${BINARY}_${OS}_${ARCH}"
  URL="https://github.com/$REPO/releases/download/$LATEST/$ASSET"
  echo "  downloading $ASSET..."
  curl -fsSL -o "$TMPDIR/$ASSET" "$URL"
done

echo "  downloading SHA256SUMS..."
curl -fsSL -o "$TMPDIR/SHA256SUMS" \
  "https://github.com/$REPO/releases/download/$LATEST/SHA256SUMS"

# ── Verify checksums ──

echo "Verifying checksums..."
cd "$TMPDIR"
for BINARY in sk subkit; do
  ASSET="${BINARY}_${OS}_${ARCH}"
  EXPECTED=$(grep "$ASSET" SHA256SUMS | awk '{print $1}')
  if [ -z "$EXPECTED" ]; then
    echo "error: no checksum found for $ASSET"; exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL=$(sha256sum "$ASSET" | awk '{print $1}')
  else
    ACTUAL=$(shasum -a 256 "$ASSET" | awk '{print $1}')
  fi
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "error: checksum mismatch for $ASSET"
    echo "  expected: $EXPECTED"
    echo "  actual:   $ACTUAL"
    exit 1
  fi
done
echo "Checksums verified."

# ── Install ──

for BINARY in sk subkit; do
  ASSET="${BINARY}_${OS}_${ARCH}"
  chmod 755 "$TMPDIR/$ASSET"
  mv "$TMPDIR/$ASSET" "$INSTALL_DIR/$BINARY"
done

# ── macOS ad-hoc codesign ──

if [ "$OS" = "darwin" ]; then
  echo "Signing binaries (macOS)..."
  for BINARY in sk subkit; do
    codesign --remove-signature "$INSTALL_DIR/$BINARY" 2>/dev/null || true
    codesign --sign - --force "$INSTALL_DIR/$BINARY"
  done
fi

echo ""
echo "Installed sk and subkit to $INSTALL_DIR"

# ── PATH guidance ──

if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
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
