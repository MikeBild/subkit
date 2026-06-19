# Install sk plus the `subkit` compatibility alias from the latest
# GitHub Release (Windows).
# Usage: irm https://raw.githubusercontent.com/mikebild/subkit/main/scripts/install.ps1 | iex
$ErrorActionPreference = "Stop"

$Repo = "mikebild/subkit"
$InstallDir = if ($env:SUBKIT_INSTALL_DIR) { $env:SUBKIT_INSTALL_DIR } else { "$env:LOCALAPPDATA\subkit\bin" }

# ── Detect architecture ──

$Arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else {
  Write-Error "32-bit Windows is not supported"
  exit 1
}

# ── Fetch latest release ──

Write-Host "Fetching latest release..."
$Release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
$Tag = $Release.tag_name
Write-Host "Installing subkit $Tag for windows/$Arch..."

# ── Create install directory ──

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# ── Download binaries + checksums ──

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "subkit-install-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

try {
    foreach ($Binary in @("sk", "subkit")) {
        $Asset = "${Binary}_windows_${Arch}.exe"
        $Url = "https://github.com/$Repo/releases/download/$Tag/$Asset"
        Write-Host "  downloading $Asset..."
        Invoke-WebRequest -Uri $Url -OutFile "$TmpDir\$Asset" -UseBasicParsing
    }

    Write-Host "  downloading SHA256SUMS..."
    Invoke-WebRequest -Uri "https://github.com/$Repo/releases/download/$Tag/SHA256SUMS" -OutFile "$TmpDir\SHA256SUMS" -UseBasicParsing

    # ── Verify checksums ──

    Write-Host "Verifying checksums..."
    $Checksums = Get-Content "$TmpDir\SHA256SUMS"
    foreach ($Binary in @("sk", "subkit")) {
        $Asset = "${Binary}_windows_${Arch}.exe"
        $ExpectedLine = $Checksums | Where-Object { $_ -match $Asset }
        if (-not $ExpectedLine) {
            Write-Error "No checksum found for $Asset"
            exit 1
        }
        $Expected = ($ExpectedLine -split '\s+')[0].ToLower()
        $Actual = (Get-FileHash "$TmpDir\$Asset" -Algorithm SHA256).Hash.ToLower()
        if ($Expected -ne $Actual) {
            Write-Error "Checksum mismatch for $Asset`n  expected: $Expected`n  actual:   $Actual"
            exit 1
        }
    }
    Write-Host "Checksums verified."

    # ── Install ──

    foreach ($Binary in @("sk", "subkit")) {
        $Asset = "${Binary}_windows_${Arch}.exe"
        Move-Item -Force "$TmpDir\$Asset" "$InstallDir\${Binary}.exe"
    }
} finally {
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Installed sk.exe and compatibility alias subkit.exe to $InstallDir"

# ── PATH guidance ──

if ($env:PATH -notlike "*$InstallDir*") {
    Write-Host ""
    Write-Host "Add to your PATH by running:"
    Write-Host "  [Environment]::SetEnvironmentVariable('PATH', ""$InstallDir;"" + [Environment]::GetEnvironmentVariable('PATH', 'User'), 'User')"
    Write-Host ""
    Write-Host "Then restart your terminal."
}

Write-Host ""
Write-Host "Run 'sk --version' to verify the installation."
Write-Host "Run 'sk update' at any time to update to the latest version."
