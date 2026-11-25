$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$ProgressPreference = "SilentlyContinue"

$SubkitVersion = $env:SUBKIT_VERSION
if (-not $SubkitVersion) { $SubkitVersion = "latest" }
$SubkitDownloadUrl = $env:SUBKIT_DOWNLOAD_URL
if (-not $SubkitDownloadUrl) { $SubkitDownloadUrl = "" }
$SubkitEngineUrl = $env:SUBKIT_ENGINE_URL
if (-not $SubkitEngineUrl) { $SubkitEngineUrl = "" }
$SubkitInstallDir = $env:SUBKIT_INSTALL_DIR
if (-not $SubkitInstallDir) { $SubkitInstallDir = Join-Path $env:LOCALAPPDATA "Programs\subkit" }
$SubkitReleasesUrl = $env:SUBKIT_RELEASES_URL
if (-not $SubkitReleasesUrl) { $SubkitReleasesUrl = "https://github.com/MikeBild/subkit/releases" }

function Fail([string]$Message) {
  Write-Error "subkit install: $Message"
  exit 1
}

function Test-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-Release([string]$Url, [string]$Output) {
  Invoke-WebRequest -Uri $Url -OutFile $Output -UseBasicParsing -MaximumRetryCount 3 -RetryIntervalSec 2
  if (-not (Test-Path $Output) -or (Get-Item $Output).Length -eq 0) { Fail "$Url returned an empty file" }
}

function Get-ExpectedHash([string]$Sums, [string]$Name) {
  $found = @(Get-Content $Sums | ForEach-Object {
      $parts = $_ -split "\s+", 2
      if ($parts.Count -eq 2 -and ($parts[1] -eq $Name -or $parts[1] -eq "*$Name")) { $parts[0] }
    })
  if ($found.Count -ne 1 -or $found[0] -notmatch "^[a-fA-F0-9]{64}$") {
    Fail "missing, duplicate or invalid checksum for $Name"
  }
  return $found[0].ToLowerInvariant()
}

if ($PSVersionTable.PSVersion.Major -lt 7) {
  Fail "PowerShell 7 or newer is needed (winget install Microsoft.PowerShell), you run $($PSVersionTable.PSVersion)"
}
if (-not $IsWindows) { Fail "this installer is for Windows; use install.sh on macOS and Linux" }
if (Test-Elevated) { Fail "run this installer as yourself, not from an administrator shell" }
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($architecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
  Fail "there is no subkit build for windows/$architecture"
}

$asset = "subkit-windows-x64.exe"
if ($SubkitDownloadUrl) {
  $base = $SubkitDownloadUrl.TrimEnd("/")
} elseif ($SubkitVersion -eq "latest") {
  $base = "$($SubkitReleasesUrl.TrimEnd('/'))/latest/download"
} elseif ($SubkitVersion -match "^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$") {
  $base = "$($SubkitReleasesUrl.TrimEnd('/'))/download/v$($SubkitVersion.TrimStart('v'))"
} else {
  Fail "SUBKIT_VERSION must be 'latest' or a version number, got '$SubkitVersion'"
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("subkit-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  Write-Host "Installing subkit $SubkitVersion for windows/x64 from $base"
  foreach ($file in @($asset, "SHA256SUMS", "LICENSE", "THIRD_PARTY_NOTICES.txt")) {
    Get-Release "$base/$file" (Join-Path $work $file)
  }
  $sums = Join-Path $work "SHA256SUMS"
  foreach ($file in @($asset, "LICENSE", "THIRD_PARTY_NOTICES.txt")) {
    $expected = Get-ExpectedHash $sums $file
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $work $file)).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { Fail "checksum mismatch for $file" }
  }
  Write-Host "  checksums: verified"
  Write-Host "  signature: not checked here (PowerShell has no Ed25519); 'subkit update' checks signed releases"

  New-Item -ItemType Directory -Force -Path $SubkitInstallDir | Out-Null
  $target = Join-Path $SubkitInstallDir "subkit.exe"
  $staged = Join-Path $SubkitInstallDir (".subkit." + [Guid]::NewGuid().ToString("N") + ".exe")
  Copy-Item (Join-Path $work $asset) $staged
  Move-Item -Force $staged $target
  Copy-Item -Force (Join-Path $work "LICENSE") (Join-Path $SubkitInstallDir "subkit.LICENSE")
  Copy-Item -Force (Join-Path $work "THIRD_PARTY_NOTICES.txt") (Join-Path $SubkitInstallDir "subkit.THIRD_PARTY_NOTICES.txt")

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = @($userPath -split ";" | Where-Object { $_ })
  if ($entries -notcontains $SubkitInstallDir) {
    [Environment]::SetEnvironmentVariable("Path", (($entries + $SubkitInstallDir) -join ";"), "User")
    $env:Path = "$env:Path;$SubkitInstallDir"
    Write-Host "  PATH: added $SubkitInstallDir for your user; open a new terminal to use it"
  }

  $installed = & $target --version 2>$null
  if (-not $installed) { $installed = $SubkitVersion }
  Write-Host ""
  Write-Host "Installed $installed to $target"
  Write-Host "License notices: $SubkitInstallDir\subkit.LICENSE and $SubkitInstallDir\subkit.THIRD_PARTY_NOTICES.txt"
  Write-Host ""
  $engine = if ($SubkitEngineUrl) { $SubkitEngineUrl } else { "<engine address>" }
  Write-Host "Next: subkit login --engine-url $engine"
  Write-Host "Keep it current with: subkit update"
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
