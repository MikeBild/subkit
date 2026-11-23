# Releasing SubKit Desktop

Signed installers are built, verified and published by one workflow:
`.github/workflows/desktop-release.yml`. It adds the desktop artifacts to the GitHub release of
a tag that the `release` workflow has already published. It never creates a release, never
replaces an asset and publishes nothing when a signing value is missing.

## What a release contains

| Platform | Artifacts | Update feed |
| --- | --- | --- |
| macOS on Apple silicon (arm64) | Download: `subkit-desktop-mac-arm64.dmg`. Update: `subkit-desktop-<version>-mac-arm64.zip` and `.zip.blockmap`. Both signed with Developer ID, notarized, ticket stapled | `latest-mac.yml` (lists only the zip) |
| Windows x64 | Update: `subkit-desktop-<version>-win-x64.exe` (NSIS) and `.exe.blockmap`. Download: `subkit-desktop-win-x64.exe`, the same installer without the version. Authenticode signed with a timestamp | `latest.yml` |
| All | `subkit-desktop-<version>-<os>-THIRD_PARTY_NOTICES.txt`, `SHA256SUMS-desktop`, `SHA256SUMS-desktop.sig` | |

The DMG is built only for the download link. `dmg.writeUpdateInfo: false` keeps it out of
`latest-mac.yml` and builds no `.dmg.blockmap`, because the updater on macOS installs the zip.
The publish job renames the DMG to its versionless name instead of copying it, so each release
carries it once. On Windows the updater downloads the versioned installer named in `latest.yml`,
so the versionless copy stays a second file.

Both platforms are first-class and independent. Each has its own engine job and its own app
job, and no job of one platform waits for the other. The publish job ships what built: it takes
every platform whose build succeeded, warns about the one that did not and checks only the
feeds it ships. There is no Linux build.

The versionless installers keep the download links stable. They always point at the newest release:

- macOS: `https://github.com/MikeBild/subkit/releases/latest/download/subkit-desktop-mac-arm64.dmg`
- Windows: `https://github.com/MikeBild/subkit/releases/latest/download/subkit-desktop-win-x64.exe`

These links never point at a release without desktop artifacts, because a release becomes
“latest” only after them; see “When a release becomes latest” below.

macOS ships for Apple silicon (arm64) only; Intel Macs get no build. `SHA256SUMS-desktop` is signed
with the same release key as `SHA256SUMS`; the existing `SHA256SUMS` of the server release is
not touched. The two stay separate files: the `release` workflow writes, signs and publishes
`SHA256SUMS` before this workflow starts, `install.sh` and the CLI updater check against it, and
the desktop builds can fail per platform. Merging would mean replacing a published, signed file
afterwards, with a window in which `SHA256SUMS` and `SHA256SUMS.sig` do not match.

## Version rule

The app carries the version of the repository. `bun run release bump <version>` writes the same version
into `package.json` and `apps/desktop/package.json`; the workflow refuses a tag whose two
versions differ, and a unit test of the app fails when they drift.

`server.desktop_min_version` (published as `clients.desktop.min_version`) is not moved by a
bump. Raise it by hand only when a server change breaks older apps, and only to a version whose
desktop artifacts are already published, otherwise nobody can update to it. The oldest server
this app accepts is `MIN_SERVER_VERSION` in `src/shared/server-contract.ts`.

## Secrets and variables

Add these under Settings → Secrets and variables → Actions of the repository. None of the
values belongs in the repository.

| Secret | What it is | Where it comes from |
| --- | --- | --- |
| `CSC_LINK` | Developer ID Application certificate with its private key, as `.p12`, base64 encoded in one line | Apple Developer account → Certificates → Developer ID Application. Create it with a certificate signing request from Keychain Access, install it, export certificate and key together as `.p12`, then `base64 -i certificate.p12 \| pbcopy`. Only the Account Holder can create this certificate type. |
| `CSC_KEY_PASSWORD` | The password chosen at the `.p12` export | You |
| `APPLE_API_KEY` | The whole text of the App Store Connect API key file (`AuthKey_<id>.p8`), including the `BEGIN` and `END` lines | App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys. The role Developer is enough for notarization. The file can be downloaded once. |
| `APPLE_API_KEY_ID` | The key id shown next to that key | Same page |
| `APPLE_API_ISSUER` | The issuer id shown above the key list | Same page |
| `WIN_CSC_LINK` | Code signing certificate with its private key, as `.pfx`, base64 encoded in one line | Your certificate authority. See “Windows signing” below. |
| `WIN_CSC_KEY_PASSWORD` | The password of that `.pfx` | You |
| `RELEASE_SIGNING_KEY` | The release key that already signs `SHA256SUMS` | Already set for the `release` workflow |

The workflow writes `APPLE_API_KEY` into a file on the runner and removes it after the build.

`RELEASE_SIGNING_KEY` is needed for any release. The signing values of one platform only decide
that platform: when the macOS values (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) or the Windows values (`WIN_CSC_LINK` and
`WIN_CSC_KEY_PASSWORD`, or the cloud signing values below) are missing, the first job skips that
platform with a warning and the release ships the other one. When both are missing, nothing is
built.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DESKTOP_RELEASE_AUTO` | unset | Unset or any value but `false`, the desktop release starts by itself after every successful `release` run of a tag. `false` leaves it to a start by hand. |
| `DESKTOP_WINDOWS_SIGNING` | `certificate` | `cloud` switches Windows to the cloud signing block. |

### Windows signing

The default block signs with `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`. Certificate authorities
today issue code signing keys on hardware or in a hosted key store, so an exportable `.pfx` may
not be available to you. For that case the workflow has a separate step, “Alternative, off by
default: build and sign with a cloud signing service”. It is skipped unless
`DESKTOP_WINDOWS_SIGNING` is `cloud`, and then needs:

| Name | Kind | Meaning |
| --- | --- | --- |
| `DESKTOP_WIN_CLOUD_SIGN_TOOL` | variable | The signing program to run, a name on the runner's path or a full path |
| `DESKTOP_WIN_CLOUD_SIGN_ARGS` | variable | Its arguments as a JSON list; `{file}` stands for the file to sign, for example `["sign", "/fd", "SHA256", "/tr", "https://timestamp.example", "/td", "SHA256", "{file}"]` |
| `DESKTOP_WIN_PUBLISHER_NAME` | variable | The subject name of the certificate, exactly as the signature shows it. The app verifies updates against this name. |
| `WIN_CLOUD_SIGN_ENV` | secret | The credentials of the service as `NAME=value` lines. Only the signing program sees them. |

`scripts/win-cloud-sign.cjs` runs that program for every file the builder signs. If the service
needs a program that is not on the runner, add its installation as a step before the
alternative block. This block has never run; expect to adjust it in the first run with real
credentials.

## Engine for local mode

There is one desktop app with both modes: it connects to a server or runs a local workspace
“Only on this Mac”. Every macOS (Apple silicon) build therefore carries the compiled engine and
PostgreSQL; there is no switch and no second builder config. The Windows app carries neither for
now: the local workspace, files, websites and apps are Mac-only (`platformCapabilities` in
`src/shared/platform-capabilities.ts` decides this in one place).

Each platform has its own engine job, so a failed build on one platform never stops another.
`bun run build desktop-engine --target <darwin-arm64|windows-x64>` builds one target; without
`--target` it builds both. The output lands in `dist/engine-desktop/<os>/<arch>/`, with the same
embedded cockpit, migrations and assets as the Linux image.

The `engine-windows` job builds `windows-x64` on Linux, the cheapest runner that compiles it, and
keeps the binary and its notices as the `engine-desktop-win` artifact. The `windows` job needs it
and starts it on Windows with `--version`, `--help` and `--smoke` before it packages the app, so
the Windows engine is checked on every release while the Windows app does not carry it yet.

The `engine-darwin` job builds `darwin-arm64` on macOS. It then:

- signs the macOS binary with the Developer ID from `CSC_LINK`, the hardened runtime, a secure
  timestamp and `assets/entitlements.mac.plist` (`scripts/codesign-macos.sh <binary> <identity>
  <entitlements>`);
- notarizes it with the App Store Connect key (`scripts/notarize-macos.sh <binary>`, which
  retries a failed upload once). A bare binary cannot carry a stapled ticket; Gatekeeper checks
  it online. `spctl -a -t exec` answers "does not seem to be an app" for any command-line tool,
  so the job checks with `spctl -a -t install`, which must answer `source=Notarized Developer ID`;
- verifies the signatures and starts the arm64 engine with `--version`, `--help` and `--smoke`.

The same command writes the engine's own notices (the packages
of the compiled engine and its embedded cockpit, the Bun runtime and the models) for each target
it builds, as `dist/engine-desktop/<os>/THIRD_PARTY_NOTICES.engine.txt`.

The `macos` job needs only `engine-darwin`. It downloads the macOS binary and packages with `electron-builder.yml`, whose base
config adds it as `Resources/local/engine`.

On macOS the job also fetches PostgreSQL for `darwin-arm64` (`scripts/fetch-postgres.ts`), signs every
Mach-O file in it with the Developer ID, the hardened runtime and a timestamp and without
entitlements (`scripts/codesign-macos-folder.sh`), and the app carries it as
`Resources/local/postgres`. electron-builder leaves these files as signed (`signIgnore`), so
PostgreSQL does not inherit the app's JIT entitlement. It needs none: `initdb`, `pgcrypto`,
the Snowball dictionaries and PL/pgSQL load and run under the hardened runtime without one.
On macOS, `scripts/notices.ts` appends the engine notices, the
PostgreSQL License and the notices of OpenSSL, ICU, libxml2, lz4 and zstd to
`THIRD_PARTY_NOTICES.txt`. After the build the job checks that the app carries the engine,
`postgres`, `initdb` and those notices, and starts `postgres --version` and `initdb --version`
from inside the app. electron-builder signs the engine again inside the app with the same
entitlements. After signing, the job checks the engine inside the app again: signature,
hardened runtime, JIT entitlement and `--version` from the signed app.

The engine needs exactly one entitlement, `com.apple.security.cs.allow-jit`. Signed with the
hardened runtime and no entitlements, Bun's JavaScriptCore runs without JIT and without
`SharedArrayBuffer`, and the engine stops at startup. `allow-unsigned-executable-memory` is not
needed. The app already uses the same file, so the app and the engine share one entitlement set.

The engine adds about 350 MB to the macOS app and PostgreSQL about 63 MB; the Windows engine
binary is about 376 MB. macOS releases are built for Apple silicon only.

To build and sign the engine and PostgreSQL on a Mac by hand:

```sh
bun run build desktop-engine --target darwin-arm64
sh scripts/codesign-macos.sh dist/engine-desktop/mac/arm64/engine "Developer ID Application: <name> (<team>)" apps/desktop/assets/entitlements.mac.plist
APPLE_API_KEY=<path to AuthKey_<id>.p8> APPLE_API_KEY_ID=<id> APPLE_API_ISSUER=<issuer> sh scripts/notarize-macos.sh dist/engine-desktop/mac/arm64/engine
bun run --cwd apps/desktop scripts/fetch-postgres.ts --target darwin-arm64
sh scripts/codesign-macos-folder.sh apps/desktop/resources/postgres/darwin-arm64 "Developer ID Application: <name> (<team>)"
```

## First dry run

A dry run builds both platforms unsigned, keeps the result as workflow artifacts for seven
days and publishes nothing. It needs no secret and no existing release.

1. Merge the workflow to `main`; a workflow can be started by hand only when its file is on
   the default branch.
2. Actions → `desktop-release` → Run workflow. Choose the branch, leave `tag` empty and tick
   `unsigned_dry_run`.
3. Download `desktop-macos` and `desktop-windows` from the run and start each
   build once. An unsigned build has updates turned off, and macOS asks before it opens it.

Then add the secrets and release for real: after the `release` workflow has published a tag,
run `desktop-release` with that tag and `unsigned_dry_run` unticked. From then on every
successful `release` run of a tag starts the desktop release by itself; set
`DESKTOP_RELEASE_AUTO` to `false` to start it only by hand. A `release` run started by hand
does not start it, so run `desktop-release` with that tag yourself.

The server release never waits for the desktop release and cannot be blocked by it.

## When a release becomes latest

`releases/latest/download/…` follows the release GitHub marks as “latest”. The app’s updater
reads `releases/latest` and then `latest-mac.yml` of that release, so a latest release without
desktop artifacts would leave every installed app without an update and the DMG link at 404.
Therefore:

1. The `release` run of a tag push publishes the release with `--latest=false`. The Docker images, the
   versioned assets and the Chrome Web Store submission go out at once; everything behind
   `releases/latest` (the CLI updater, `install.sh`, the Compose file, the Web Clipper ZIP, the
   desktop updater and the DMG) still serves the previous release.
2. `desktop-release` builds, verifies and uploads the desktop artifacts.
3. Its last job, `promote`, marks the release latest and checks that `releases/latest` now
   names the tag.

| Time | Before | Now |
| --- | --- | --- |
| `release` publishes | New release is latest without desktop assets: `latest-mac.yml` and the DMG answer 404 | New release is published, not latest: all `latest` links serve the previous, complete release |
| About 40 minutes later, `desktop-release` uploads | Desktop assets appear, the gap closes | `promote` marks the new release latest: every channel moves at once |
| Desktop build fails or is skipped | The 404 stays until someone reruns | `promote` still marks it latest, with a warning naming the missing assets |

`promote` runs whenever the `release` run came from a tag push, also when the desktop build
failed, `DESKTOP_RELEASE_AUTO` is `false`, signing values are missing or the `release` run
failed after publishing. It changes nothing when the release is still a draft, is a
prerelease, or a newer release exists. A manual `desktop-release` run with a tag ends with the
same job. A `release` run started by hand does not start `desktop-release`, so it marks the
release latest itself, with a warning to run `desktop-release` with the tag. When the warning says desktop assets are missing, fix the cause and run
`desktop-release` with the tag again: the updater then finds the version.

When the updater finds no feed (a 404 on `releases/latest` or on `latest-mac.yml`), the app
shows “You’re on the latest version” instead of a failed check and writes
`update.feed_missing` with the checked URL and the HTTP status to its log. Any other failure
writes `update.failed` with the same fields.

## What the workflow checks before it publishes

- Missing checksum signing key: the first job stops and nothing is built. Missing signing values
  of one platform: the first job skips that platform with a warning, and the release ships the
  other one.
- The tag must equal both versions, and in an automatic run the commit that was released.
- The tag must point to a commit in the first-parent history of `main`. An automatic run starts
  only after a push to this repository. The first job resolves that commit, and every build job
  checks out exactly that commit id, never the tag or a branch name, so a tag moved during the
  run changes nothing. Setup steps run without the Actions cache.
- macOS: `codesign --verify --deep --strict`, a Developer ID authority, the hardened runtime,
  `spctl -a -t exec` and `xcrun stapler validate` for the app inside the zip and the dmg.
- Windows: `signtool verify /pa /all`, a valid signature status and a timestamp for the
  installer and the app, and a publisher name in `app-update.yml`.
- Every feed file must name the released version, carry no staged rollout percentage and list
  only files of this release with matching SHA-512 and size.
- After the upload the job downloads the desktop artifacts again and checks them against the
  signed `SHA256SUMS-desktop`.

A run that fails after some files were uploaded leaves them on the release. Delete the desktop
assets (`subkit-desktop-*`, `latest.yml`, `latest-mac.yml`, `SHA256SUMS-desktop*`) from the release and start the
workflow again with the tag; it refuses a release that already carries desktop assets. If the
repository makes published releases immutable, later uploads are refused: then this workflow
cannot add to a release, and the desktop build has to move into the `release` workflow before
the draft is published.

## Verify a downloaded build

Checksums, both platforms:

```sh
gh release download v<version> --repo MikeBild/subkit --pattern 'subkit-desktop-*' --pattern 'latest*.yml' --pattern 'SHA256SUMS-desktop*'
sha256sum --strict --check SHA256SUMS-desktop
openssl pkeyutl -verify -pubin -inkey release-public-key.pem -rawin -in SHA256SUMS-desktop -sigfile SHA256SUMS-desktop.sig
```

`release-public-key.pem` holds the key from `packages/cli-core/src/release-public-key.ts`.

macOS:

```sh
codesign --verify --deep --strict --verbose=2 /Applications/SubKit.app
codesign --display --verbose=4 /Applications/SubKit.app 2>&1 | grep -E 'Authority|TeamIdentifier|flags'
spctl -a -t exec -vv /Applications/SubKit.app
xcrun stapler validate /Applications/SubKit.app
```

`spctl` must answer `accepted` with `source=Notarized Developer ID`.

Windows, in PowerShell:

```powershell
Get-AuthenticodeSignature .\subkit-desktop-<version>-win-x64.exe | Format-List Status, SignerCertificate, TimeStamperCertificate
signtool verify /pa /all /v .\subkit-desktop-<version>-win-x64.exe
```

## App identity, permissions and entitlements on macOS

The bundle id `dev.mikebild.subkit.desktop` (development: `dev.mikebild.subkit.desktop.dev`)
stays fixed: updates, the keychain entries and the macOS privacy settings are bound to it.
electron-builder names the helper apps `SubKit Helper`, `SubKit Helper (GPU)`,
`SubKit Helper (Plugin)` and `SubKit Helper (Renderer)` with the ids
`dev.mikebild.subkit.desktop.helper[.GPU|.Plugin|.Renderer]`; `scripts/after-pack.cjs` also
replaces the `Electron Helper` name that Electron leaves in their `CFBundleName`.

Entitlements (`assets/entitlements.mac.plist`, for the app and every helper it signs):

| Entitlement | Why |
| --- | --- |
| `com.apple.security.cs.allow-jit` | V8 in Electron and JavaScriptCore in the engine compile JavaScript at run time. Under the hardened runtime they stop at startup without it. |

Nothing else. `disable-library-validation` is not needed because every library in the bundle
is signed with the same team; `allow-unsigned-executable-memory` is not needed because both
runtimes use `MAP_JIT`. PostgreSQL, agent-browser and agent-desktop need no entitlement: they
are signed beforehand without one and must be listed in `signIgnore`, otherwise
electron-builder signs them again with this file.

Info.plist (`mac.extendInfo` in `electron-builder.base.yml`; the German and English texts are
in `src/shared/app-identity.ts`, and `scripts/build.ts` writes them as
`de.lproj/InfoPlist.strings` and `en.lproj/InfoPlist.strings`):

| Key | Why |
| --- | --- |
| `NSDesktopFolderUsageDescription`, `NSDocumentsFolderUsageDescription`, `NSDownloadsFolderUsageDescription` | Steps on the device read and write in folders the person allowed, also inside these three. |
| `NSRemovableVolumesUsageDescription`, `NSNetworkVolumesUsageDescription` | An allowed folder may lie on an external or network drive; only the volume root itself is refused. |
| `NSLocalNetworkUsageDescription` | A SubKit server may run in the local network; any `https://` address is accepted. |
| `NSHumanReadableCopyright`, `LSMinimumSystemVersion` 13.0, `LSApplicationCategoryType` productivity | Shown in Finder and the About panel; 13.0 is the oldest macOS Electron 45 runs on. |

The generic camera, microphone, audio capture and Bluetooth strings of Electron are removed:
every session refuses media and device requests. There is no `NSAppleEventsUsageDescription`
because the app sends no Apple Events. Accessibility and Screen Recording have no Info.plist
key; macOS lists the app in System Settings, and the permissions step in the connect window
says why SubKit needs each one.

Icons: `assets/icon-mac.svg` (the Cockpit mark on the macOS icon grid), `assets/tray.svg` and
`assets/dmg-background.svg` are the sources. `bun run build --icons` renders `icon.icns`
(16 to 1024 pixels), `icon-mac.png` (dock icon of an unpackaged start), `trayTemplate.png` and
`@2x`, and the DMG background at 1x and 2x plus `dmg-background.tiff` with both, on a Mac with
`rsvg-convert`. Notifications, the Dock and the About panel of the packaged app use the bundle
icon. Windows keeps `assets/icon.png`.

The DMG volume is called “SubKit <version>”. Its hidden `.background.tiff` and
`.VolumeIcon.icns` are listed in `dmg.contents` with a position far below the window, so a
Finder that shows hidden files does not draw them over the app icon and the Applications link.

To check a build, here an unsigned one:

```sh
cd apps/desktop && CSC_IDENTITY_AUTO_DISCOVERY=false bun run package --prebuilt --dir --mac --arm64 -c.mac.identity=- -c.mac.notarize=false --publish never
plutil -p release/mac-arm64/SubKit.app/Contents/Info.plist
codesign -d --entitlements :- release/mac-arm64/SubKit.app
```

## Roll back an update

The app never installs an older version (`allowDowngrade` is off), and a published tag is never
reused. A bad desktop build is therefore withdrawn in two steps:

1. Stop the rollout: delete `latest-mac.yml` and `latest.yml` from the bad
   release (`gh release delete-asset v<version> latest-mac.yml`, and so on). Apps then find no
   feed, report that they are on the latest version and stay on the version they have. Apps that already installed the bad
   version keep it.
2. Fix forward: release the next version with the fix and publish its desktop artifacts. Every
   app, including those on the bad version, updates to it.

Deleting only the feed files keeps the installers downloadable. Delete those too when nobody
should install the build by hand. If the bad build cannot start at all, it cannot update
itself: people have to download the fixed installer.

To keep old apps from signing in to a server they no longer fit, raise
`server.desktop_min_version` on that server; such an app asks for an update instead of signing
in.

## License notices: what the owner should confirm

Every package carries `THIRD_PARTY_NOTICES.txt`, the Electron license and
`LICENSES.chromium.html` (next to the binary on Windows, in `Contents/Resources` on
macOS). The notices end with a section on FFmpeg, the one LGPL component that the Electron
runtime ships as a separate shared library. Its facts are read from `LICENSES.chromium.html` of
the Electron distribution the package was built from; the build stops when that file no longer
has an FFmpeg entry with the LGPL statement and the text of LGPL 2.1.

Before the first public release, confirm:

1. The written offer. The notices promise the corresponding FFmpeg source on request for three
   years through the contact form at `https://subkit.mikebild.dev/kontakt`. This is the same
   offer the engine notices make. Confirm that you stand behind it for the desktop package, or
   change the text in `ffmpeg.statement` of `vendor/desktop-runtime-notices/manifest.json`.
2. The source revision. The manifest names the FFmpeg revision pinned in the `DEPS` file of the
   Chromium release that Electron 45.4.1 builds on. It was read from that file, not from the
   shipped library. Update `ffmpeg`, `runtime` and the pinned files in the manifest with every
   Electron upgrade; the notices script stops when the Electron version and the manifest
   differ.
3. The build options. The license file does not say how the shipped FFmpeg was configured. That
   it contains none of the optional GPL parts is the statement of the Electron project and is
   marked UNVERIFIED in the notices.
4. Replacing the library. The LGPL asks that a recipient can use a modified library. FFmpeg is
   a separate file and the app does not check it itself, but a signed macOS app must be signed
   again after any file in it changed. The notices say so. Confirm that this is acceptable to
   you.
5. What is still not covered, as the `scope` of the manifest lists: the per-platform
   differences of `LICENSES.chromium.html` (each platform ships its own file), the installer components that the builder adds
   on Windows, and legal approval as such. The notices are a
   draft, not a distribution approval.
