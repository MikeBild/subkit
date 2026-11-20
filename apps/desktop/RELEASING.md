# Releasing SubKit Desktop

Signed installers are built, verified and published by one workflow:
`.github/workflows/desktop-release.yml`. It adds the desktop artifacts to the GitHub release of
a tag that the `release` workflow has already published. It never creates a release, never
replaces an asset and publishes nothing when a signing value is missing.

## What a release contains

| Platform | Artifacts | Update feed |
| --- | --- | --- |
| macOS arm64 and x64 | `subkit-desktop-<version>-mac-<arch>.dmg` and `.zip`, signed with Developer ID, notarized, ticket stapled | `latest-mac.yml` |
| Windows x64 | `subkit-desktop-<version>-win-x64.exe` (NSIS), Authenticode signed with a timestamp | `latest.yml` |
| Linux x64 | `subkit-desktop-<version>-linux-<arch>.AppImage` and `.deb` | `latest-linux.yml` |
| All | block maps, `subkit-desktop-<version>-<os>-THIRD_PARTY_NOTICES.txt`, `SHA256SUMS-desktop`, `SHA256SUMS-desktop.sig` | |

macOS ships one build per architecture instead of a universal one: the download is half the
size and the app has no native module that would need merging. `SHA256SUMS-desktop` is signed
with the same release key as `SHA256SUMS`; the existing `SHA256SUMS` of the server release is
not touched.

## Version rule

The app carries the version of the repository. `bun run bump <version>` writes the same version
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

| Variable | Default | Meaning |
| --- | --- | --- |
| `DESKTOP_RELEASE_AUTO` | unset | `true` starts the desktop release by itself after every successful `release` run of a tag. Unset, the desktop release starts only by hand. |
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

## First dry run

A dry run builds all three platforms unsigned, keeps the result as workflow artifacts for seven
days and publishes nothing. It needs no secret and no existing release.

1. Merge the workflow to `main`; a workflow can be started by hand only when its file is on
   the default branch.
2. Actions → `desktop-release` → Run workflow. Choose the branch, leave `tag` empty and tick
   `unsigned_dry_run`.
3. Download `desktop-macos`, `desktop-windows` and `desktop-linux` from the run and start each
   build once. An unsigned build has updates turned off, and macOS asks before it opens it.

Then add the secrets and release for real: after the `release` workflow has published a tag,
run `desktop-release` with that tag and `unsigned_dry_run` unticked. When that has worked once,
set `DESKTOP_RELEASE_AUTO` to `true` if every server release should carry the desktop app.

The server release never waits for the desktop release and cannot be blocked by it. Until the
desktop artifacts of the newest release are uploaded, installed apps report a failed update
check and try again later, because the newest release has no feed file yet. With
`DESKTOP_RELEASE_AUTO` that gap is the build time of the desktop workflow.

## What the workflow checks before it publishes

- Missing signing value: the first job stops with the list of missing names. Nothing is built.
- The tag must equal both versions, and in an automatic run the commit that was released.
- macOS: `codesign --verify --deep --strict`, a Developer ID authority, the hardened runtime,
  `spctl -a -t exec` and `xcrun stapler validate` for the app inside every zip and every dmg.
- Windows: `signtool verify /pa /all`, a valid signature status and a timestamp for the
  installer and the app, and a publisher name in `app-update.yml`.
- Every feed file must name the released version, carry no staged rollout percentage and list
  only files of this release with matching SHA-512 and size.
- After the upload the job downloads the desktop artifacts again and checks them against the
  signed `SHA256SUMS-desktop`.

A run that fails after some files were uploaded leaves them on the release. Delete the desktop
assets (`subkit-desktop-*`, `latest*.yml`, `SHA256SUMS-desktop*`) from the release and start the
workflow again with the tag; it refuses a release that already carries desktop assets. If the
repository makes published releases immutable, later uploads are refused: then this workflow
cannot add to a release, and the desktop build has to move into the `release` workflow before
the draft is published.

## Verify a downloaded build

Checksums, any platform:

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

Linux: the checksum check above is the whole verification; AppImage and deb carry no signature.

## Roll back an update

The app never installs an older version (`allowDowngrade` is off), and a published tag is never
reused. A bad desktop build is therefore withdrawn in two steps:

1. Stop the rollout: delete `latest-mac.yml`, `latest.yml` and `latest-linux.yml` from the bad
   release (`gh release delete-asset v<version> latest-mac.yml`, and so on). Apps then report a
   failed update check and stay on the version they have. Apps that already installed the bad
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
`LICENSES.chromium.html` (next to the binary on Windows and Linux, in `Contents/Resources` on
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
   differences of `LICENSES.chromium.html` (each platform ships its own file; the macOS job
   reads the arm64 one for both architectures), the installer components that the builder adds
   on Windows, the AppImage runtime on Linux, and legal approval as such. The notices are a
   draft, not a distribution approval.
