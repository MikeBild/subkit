# 34 — Installation

This document covers installation, setup, auto-update, and uninstall for all platforms and all four binaries.

## Available Binaries

Each GitHub Release publishes 20 binaries (4 binaries × 5 platforms) plus a `SHA256SUMS` checksum file:

| Binary | macOS ARM64 | macOS x64 | Linux x64 | Linux ARM64 | Windows x64 |
|--------|:-----------:|:---------:|:---------:|:-----------:|:-----------:|
| `engine` | x | x | x | x | x |
| `sk` | x | x | x | x | x |
| `subkit` | x | x | x | x | x |
| `tunnel-agent` | x | x | x | x | x |

Binary naming convention: `{name}_{os}_{arch}[.exe]`

Examples: `engine_linux_x64`, `sk_darwin_arm64`, `subkit_linux_x64`, `tunnel-agent_windows_x64.exe`

## Quick Install

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/mikebild/subkit/main/scripts/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/mikebild/subkit/main/scripts/install.ps1 | iex
```

Both scripts install `sk` and `subkit` (not `tunnel-agent` — install that separately if needed).

Override the install directory with `SUBKIT_INSTALL_DIR`:

```bash
SUBKIT_INSTALL_DIR=/usr/local/bin curl -fsSL https://raw.githubusercontent.com/mikebild/subkit/main/scripts/install.sh | bash
```

## Install Script Details

### `scripts/install.sh` (macOS / Linux)

1. Detects OS via `uname -s` (`darwin` or `linux`)
2. Detects architecture via `uname -m` (`x64` or `arm64`)
3. Fetches the latest release tag from `api.github.com`
4. Downloads `sk_{os}_{arch}` and `subkit_{os}_{arch}` to a temp directory
5. Downloads `SHA256SUMS` and verifies each binary (uses `sha256sum` on Linux, `shasum -a 256` on macOS)
6. Sets `chmod 755` on both binaries
7. On macOS: runs `codesign --remove-signature` then `codesign --sign - --force` (ad-hoc signing for AMFI)
8. Moves binaries to `$SUBKIT_INSTALL_DIR` (default: `~/.subkit/bin/`)
9. Prints PATH setup instructions for the user's shell (`zsh`, `bash`, or `sh`)

### `scripts/install.ps1` (Windows)

1. Detects 64-bit OS (32-bit is unsupported)
2. Fetches the latest release tag from `api.github.com`
3. Downloads `sk_windows_x64.exe` and `subkit_windows_x64.exe` to a temp directory
4. Downloads `SHA256SUMS` and verifies each binary via `Get-FileHash`
5. Moves binaries to `$env:SUBKIT_INSTALL_DIR` (default: `%LOCALAPPDATA%\subkit\bin\`)
6. Prints instructions to add the directory to the user PATH

## Manual Install by Platform

### macOS (Apple Silicon — ARM64)

```bash
curl -fsSL -o sk https://github.com/mikebild/subkit/releases/latest/download/sk_darwin_arm64
curl -fsSL -o subkit https://github.com/mikebild/subkit/releases/latest/download/subkit_darwin_arm64
chmod +x sk subkit
codesign --sign - --force sk subkit
sudo mv sk subkit /usr/local/bin/
```

### macOS (Intel — x64)

```bash
curl -fsSL -o sk https://github.com/mikebild/subkit/releases/latest/download/sk_darwin_x64
curl -fsSL -o subkit https://github.com/mikebild/subkit/releases/latest/download/subkit_darwin_x64
chmod +x sk subkit
codesign --sign - --force sk subkit
sudo mv sk subkit /usr/local/bin/
```

### Linux (x86_64)

```bash
curl -fsSL -o sk https://github.com/mikebild/subkit/releases/latest/download/sk_linux_x64
curl -fsSL -o subkit https://github.com/mikebild/subkit/releases/latest/download/subkit_linux_x64
chmod +x sk subkit
sudo mv sk subkit /usr/local/bin/
```

### Linux (ARM64 / aarch64)

```bash
curl -fsSL -o sk https://github.com/mikebild/subkit/releases/latest/download/sk_linux_arm64
curl -fsSL -o subkit https://github.com/mikebild/subkit/releases/latest/download/subkit_linux_arm64
chmod +x sk subkit
sudo mv sk subkit /usr/local/bin/
```

### Windows (x64)

```powershell
New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\subkit\bin" | Out-Null
Invoke-WebRequest -Uri "https://github.com/mikebild/subkit/releases/latest/download/sk_windows_x64.exe" -OutFile "$env:LOCALAPPDATA\subkit\bin\sk.exe"
Invoke-WebRequest -Uri "https://github.com/mikebild/subkit/releases/latest/download/subkit_windows_x64.exe" -OutFile "$env:LOCALAPPDATA\subkit\bin\subkit.exe"
# Add to PATH:
[Environment]::SetEnvironmentVariable('PATH', "$env:LOCALAPPDATA\subkit\bin;" + [Environment]::GetEnvironmentVariable('PATH', 'User'), 'User')
```

## Verifying Checksums Manually

Every release includes a `SHA256SUMS` file. To verify a downloaded binary:

```bash
# Download the checksum file
curl -fsSL -o SHA256SUMS https://github.com/mikebild/subkit/releases/latest/download/SHA256SUMS

# Verify (Linux)
sha256sum -c SHA256SUMS --ignore-missing

# Verify (macOS)
shasum -a 256 -c SHA256SUMS --ignore-missing
```

On Windows:
```powershell
$expected = (Get-Content SHA256SUMS | Select-String "sk_windows_x64.exe") -replace '\s+.*', ''
$actual = (Get-FileHash sk_windows_x64.exe -Algorithm SHA256).Hash.ToLower()
if ($expected -eq $actual) { "OK" } else { "MISMATCH" }
```

## macOS Code Signing

Bun-compiled binaries ship without a code signature. On macOS (especially Apple Silicon), AMFI refuses to launch unsigned executables. The install script and `sk update` both apply ad-hoc signing automatically. To sign manually:

```bash
codesign --remove-signature path/to/binary 2>/dev/null || true
codesign --sign - --force path/to/binary
codesign -dv path/to/binary 2>&1 | grep Signature   # expect: Signature=adhoc
```

The `--remove-signature` step is required because Bun embeds an `LC_CODE_SIGNATURE` load command that blocks a direct re-sign.

## Updating All Binaries

### CLIs (`sk`, `subkit`)

```bash
sk update              # interactive update with progress
subkit update          # same for operator CLI
```

Options: `--force` (re-download), `--channel beta` (pre-release builds).

### Server binaries (`engine`, `tunnel-agent`)

Server binaries use `--self-update` — they download the new binary and exit. The operator restarts the process:

```bash
# Engine
engine --self-update
sudo systemctl restart subkit-engine   # or however you manage the process

# Tunnel agent
tunnel-agent --self-update
sudo systemctl restart subkit-tunnel-agent
```

Both server binaries also check for updates automatically:
- **Engine**: checks on startup, exposes `update_available`/`latest_version` in `/v1/health`
- **Tunnel agent**: checks on startup and every 24 hours while running

Neither server binary ever auto-restarts — they log a warning and wait for the operator.

## Uninstall

### macOS / Linux

```bash
# Remove binaries
sudo rm -f /usr/local/bin/sk /usr/local/bin/subkit /usr/local/bin/tunnel-agent
# Or if installed to ~/.subkit/bin:
rm -rf ~/.subkit/bin

# Remove config and cache
rm -rf ~/.sk ~/.subkit
```

### Windows

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\subkit"
# Remove from PATH:
$path = [Environment]::GetEnvironmentVariable('PATH', 'User')
$path = ($path -split ';' | Where-Object { $_ -notlike '*subkit*' }) -join ';'
[Environment]::SetEnvironmentVariable('PATH', $path, 'User')
```

---

## Setting Up the CLIs

### `sk` — end-user CLI

`sk` stores profiles in `~/.sk/config.json`. Each profile holds an engine URL, API key, and active tenant.

| Login method | Command | Use case |
|---|---|---|
| API key | `sk login --engine-url <url> --api-key <key>` | Scripted / CI |
| Browser (OIDC) | `sk login --engine-url <url>` | Interactive, opens browser |
| Portal token | `sk login --engine-url <url> --portal-token <token>` | Portal-locked end users |

**Multiple profiles:**
```bash
sk login --engine-url https://staging.example.com --api-key <key> --profile staging
sk login --engine-url https://prod.example.com    --api-key <key> --profile prod
sk status --profile staging
```

**Precedence:** CLI flag → env var (`SUBKIT_ENGINE_URL`, `SUBKIT_API_KEY`) → disk profile → default.

### `subkit` — operator CLI

`subkit` stores profiles in `~/.subkit/config.json` with the same format and precedence as `sk`.

```bash
subkit login --engine-url https://your-engine.example.com --api-key <key>
subkit login --engine-url https://your-engine.example.com   # OIDC device flow
subkit profile set staging --engine-url https://staging.example.com --api-key <key>
subkit profile use staging
subkit profile list
```

### `tunnel-agent`

```bash
tunnel-agent \
  --engine-url wss://subkit-tunnel.your-domain.com \
  --api-key wf_live_abc123 \
  --targets "my-api=http://localhost:3000/,internal-svc=http://10.0.0.5:8080/"
```

Environment variable configuration (for systemd / container deploys):
```bash
export SUBKIT_ENGINE_URL=wss://subkit-tunnel.your-domain.com
export SUBKIT_API_KEY=wf_live_abc123
export SUBKIT_TARGETS="my-api=http://localhost:3000/"
tunnel-agent
```

---

## Auto-Update (OTA)

All four binaries have built-in OTA updates from GitHub Releases.

### Update capabilities

| Binary | Startup check | Update command | Periodic re-check | Health endpoint |
|--------|:---:|:---:|:---:|:---:|
| `sk` | background, banner on stderr | `sk update` | via startup (24h cache) | n/a |
| `subkit` | background, banner on stderr | `subkit update` | via startup (24h cache) | n/a |
| `engine` | background, structured log | `engine --self-update` | via startup (24h cache) | `/v1/health` → `update_available`, `latest_version` |
| `tunnel-agent` | background, structured log | `tunnel-agent --self-update` | every 24h (long-running) | n/a |

### What the update does

1. Queries `api.github.com/repos/mikebild/subkit/releases/latest`
2. Compares remote version against running binary's embedded version
3. Downloads the correct binary for current OS/architecture
4. Downloads `SHA256SUMS` and verifies the hash
5. On macOS: ad-hoc codesigns the binary
6. Atomically replaces the running binary (rename → move → cleanup)
7. On Windows: renames running `.exe` to `.old`, writes new, cleans up on next run

- Server binaries (`engine`, `tunnel-agent`): `--self-update` downloads and exits — operator restarts
- CLI binaries: in-place update, no restart needed
- Permission error → prints `run with sudo: sudo sk update`

### Disable auto-check

```bash
export NO_UPDATE_CHECK=1
```
