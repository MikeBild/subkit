#!/usr/bin/env bash
set -euo pipefail

SUBKIT_VERSION="${SUBKIT_VERSION:-latest}"
SUBKIT_DOWNLOAD_URL="${SUBKIT_DOWNLOAD_URL:-}"
SUBKIT_ENGINE_URL="${SUBKIT_ENGINE_URL:-}"
SUBKIT_INSTALL_DIR="${SUBKIT_INSTALL_DIR:-$HOME/.local/bin}"
SUBKIT_RELEASES_URL="${SUBKIT_RELEASES_URL:-https://github.com/MikeBild/subkit/releases}"

fail() {
  echo "subkit install: $*" >&2
  exit 1
}

download() {
  local url="$1" output="$2"
  case "$url" in
    https://*) curl --proto '=https' --proto-redir '=https' --retry 3 --retry-delay 2 -fsSL -o "$output" "$url" ;;
    *) curl --retry 3 --retry-delay 2 -fsSL -o "$output" "$url" ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "neither sha256sum nor shasum is on PATH"
  fi
}

verify_signature() {
  local dir="$1"
  if ! download "$BASE/SHA256SUMS.sig" "$dir/SHA256SUMS.sig" 2>/dev/null || [ ! -s "$dir/SHA256SUMS.sig" ]; then
    echo "  signature: not published at $BASE, checksums only"
    return 0
  fi
  cat > "$dir/release-public-key.pem" <<'PUBLIC_KEY'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAyF3lL39nLly5M13CruFCrfZJfJiCcvlyJi/ZeTIhe/U=
-----END PUBLIC KEY-----
PUBLIC_KEY
  local output
  if output=$(openssl pkeyutl -verify -pubin -inkey "$dir/release-public-key.pem" \
    -rawin -in "$dir/SHA256SUMS" -sigfile "$dir/SHA256SUMS.sig" 2>&1); then
    echo "  signature: verified"
  elif printf '%s' "$output" | grep -q "Signature Verification Failure"; then
    fail "the signature of SHA256SUMS does not match the release key"
  else
    echo "  signature: skipped, this OpenSSL cannot check Ed25519 (install OpenSSL 3 to check it)"
  fi
}

main() {
  local os arch ext="" binary="subkit"
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN*) os=windows ext=".exe" ;;
    *) fail "unsupported operating system: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
  local asset="subkit-${os}-${arch}${ext}"
  case "$asset" in
    subkit-darwin-arm64 | subkit-linux-x64 | subkit-linux-arm64 | subkit-windows-x64.exe) ;;
    *) fail "there is no subkit build for ${os}/${arch}" ;;
  esac

  if [ -n "$SUBKIT_DOWNLOAD_URL" ]; then
    BASE="${SUBKIT_DOWNLOAD_URL%/}"
  elif [ "$SUBKIT_VERSION" = latest ]; then
    BASE="${SUBKIT_RELEASES_URL%/}/latest/download"
  elif [[ "$SUBKIT_VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    BASE="${SUBKIT_RELEASES_URL%/}/download/v${SUBKIT_VERSION#v}"
  else
    fail "SUBKIT_VERSION must be 'latest' or a version number, got '$SUBKIT_VERSION'"
  fi

  WORK_DIR=$(mktemp -d)
  trap 'rm -rf "$WORK_DIR"' EXIT
  local tmp="$WORK_DIR"

  echo "Installing subkit ${SUBKIT_VERSION} for ${os}/${arch} from ${BASE}"
  local file
  for file in "$asset" SHA256SUMS LICENSE THIRD_PARTY_NOTICES.txt; do
    download "$BASE/$file" "$tmp/$file" || fail "could not download $file from $BASE"
    [ -s "$tmp/$file" ] || fail "$file is empty"
  done

  verify_signature "$tmp"
  local expected actual
  for file in "$asset" LICENSE THIRD_PARTY_NOTICES.txt; do
    expected=$(awk -v name="$file" '$2 == name || $2 == "*" name { print $1 }' "$tmp/SHA256SUMS")
    [[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || fail "missing, duplicate or invalid checksum for $file"
    actual=$(sha256_of "$tmp/$file")
    [ "$expected" = "$actual" ] || fail "checksum mismatch for $file"
  done
  echo "  checksums: verified"

  local target
  for target in "$binary$ext" subkit.LICENSE subkit.THIRD_PARTY_NOTICES.txt; do
    [ ! -d "$SUBKIT_INSTALL_DIR/$target" ] || fail "$SUBKIT_INSTALL_DIR/$target is a directory"
  done
  mkdir -p "$SUBKIT_INSTALL_DIR"
  local staged
  for file in LICENSE THIRD_PARTY_NOTICES.txt; do
    staged=$(mktemp "$SUBKIT_INSTALL_DIR/.subkit.XXXXXXXX")
    cp "$tmp/$file" "$staged"
    chmod 644 "$staged"
    mv -f "$staged" "$SUBKIT_INSTALL_DIR/subkit.$file"
  done
  staged=$(mktemp "$SUBKIT_INSTALL_DIR/.subkit.XXXXXXXX")
  cp "$tmp/$asset" "$staged"
  chmod 755 "$staged"
  mv -f "$staged" "$SUBKIT_INSTALL_DIR/$binary$ext"

  echo ""
  echo "Installed $("$SUBKIT_INSTALL_DIR/$binary$ext" --version 2>/dev/null || echo "$SUBKIT_VERSION") to $SUBKIT_INSTALL_DIR/$binary$ext"
  echo "License notices: $SUBKIT_INSTALL_DIR/subkit.LICENSE and $SUBKIT_INSTALL_DIR/subkit.THIRD_PARTY_NOTICES.txt"
  if [[ ":$PATH:" != *":$SUBKIT_INSTALL_DIR:"* ]]; then
    echo ""
    echo "Add $SUBKIT_INSTALL_DIR to your PATH, for example:"
    echo "  export PATH=\"$SUBKIT_INSTALL_DIR:\$PATH\""
  fi
  echo ""
  echo "Next: subkit login --engine-url ${SUBKIT_ENGINE_URL:-<engine address>}"
  echo "Keep it current with: subkit update"
}

main "$@"
