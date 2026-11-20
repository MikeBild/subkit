# SubKit Desktop

A thin, hardened Electron shell for SubKit. It has no UI of its own beyond a small connect
screen: it loads `<server>/cockpit` same-origin in a sandboxed window with the normal Cockpit
cookie session, and brings the attention list to the tray, the dock badge and native
notifications. There is no API key in the window, no local server and no local execution.

## Run it in development

```sh
cd apps/desktop
bun install
bun run dev
```

`bun run dev` bundles into `dist/` and starts Electron. The Electron binary is downloaded on
the first start. Start a local server with `bun run start:local` in the repository root and
enter `localhost:3000` in the connect screen. A server without the desktop login (no
`clients.desktop` in its service descriptor) is reported as too old.

| Script | What it does |
| --- | --- |
| `bun run build` | Bundle main process, preloads and connect screen into `dist/` as a development build |
| `bun run dev` | Build, then start Electron |
| `bun run test` | Unit tests for the pure logic in `src/shared` |
| `bun run typecheck` | `tsc` for this app (uses the TypeScript of the repository root) |
| `bun run notices` | Write `dist/THIRD_PARTY_NOTICES.txt` for the bundled packages, the runtime and its FFmpeg library; needs the Electron distribution |
| `bun run notices:check` | The same checks without writing; the gate runs it |
| `bun run verify:feed <dir> <version>` | Compare the update feed files in a folder with the artifacts next to them |
| `bun run tray-icon` | Render the menu bar template image from the Cockpit mark (needs `rsvg-convert`) |
| `bun run package` | Production build, notices, then `electron-builder` for the current platform |
| `bun run package:dir` | The same, unpacked into `release/` without installers |
| `bun run package:dev` | Development build, unpacked into `release-dev/` as “SubKit Dev” |

`apps/desktop` is a standalone package with its own `bun.lock`. It is deliberately not part of
the root workspace, so the Electron toolchain stays out of the root lockfile and out of the
engine notices. Run `bun install` in the repository root once as well: lint, the TypeScript
compiler and the notice scripts come from there.

## Layout

```
src/shared/    pure logic with unit tests, no Electron import
src/main/      main process
src/preload/   bridges: window.subkitConnect (connect screen), window.subkitDesktop (Cockpit)
src/connect/   connect and settings screen, German and English
scripts/       build.ts, notices.ts, fonts.ts, tray-icon.ts
```

Everything the shell assumes about the server lives in `src/shared/server-contract.ts`
(paths, descriptor fields, answers, error codes) and `src/main/server-client.ts` (the three
requests). Adjust those two files when the contract changes.

## Production and development builds

Two builds must never answer the same link. Only a packaged build made with `--production`
(`bun run package`) is the production channel; `bun run dev`, `bun run package:dev` and every
unpackaged start are the development channel. `src/shared/channel.ts` holds both:

| | Production | Development |
| --- | --- | --- |
| Name and data folder | SubKit | SubKit Dev |
| Bundle id / app user model id | `dev.mikebild.subkit.desktop` | `dev.mikebild.subkit.desktop.dev` |
| Link scheme | `subkit://` | `subkit-dev://` |
| Linux autostart entry | `subkit-desktop.desktop` | `subkit-desktop-dev.desktop` |
| Updates | when the build is signed and has a feed | never |

A build reads only links of its own scheme. A development build signs in only on a server
that lists `subkit-dev://callback`: every engine that does not run with `NODE_ENV=production`,
or one with `server.desktop_dev_callback: true`. A production server reports a development
build as too old for it.

## Server contract the shell codes against

The shell needs a server from version 11.2.0 on, the first release with the desktop sign-in.

- `GET /.well-known/service-descriptor.json` with `version` and `clients.desktop`:
  `min_version` and `login` with `start`, `session`, `callback` (`subkit://callback`),
  `callbacks` (every accepted target) and `code_challenge_methods` (must list `S256`). A server
  that does not list the callback of this build, or no `S256`, asks for a newer app.
- Login: system browser at `login.start` with `code_challenge` (43 characters),
  `code_challenge_method=S256`, `state`, `device_id`, `device_label` (at most 64 characters, no
  control characters) and `redirect_uri` (the callback of this build). The device id is a UUID
  that the shell creates when a sign-in starts and writes to `profiles.json` only after the
  exchange succeeded; it survives sign-out and is dropped only when the server is removed. A
  sign-in that is cancelled, refused or never finished leaves no profile. The person signs in
  and confirms the device in the browser, then the server redirects to
  `<scheme>://callback?code&state` or `<scheme>://callback?error=access_denied&state`.
- Exchange: the main process posts `{code, code_verifier, state}` as JSON to `login.session`
  through the window session and reads `{installation_id, cockpit_path, created}`. The request
  carries no `Origin` and `Sec-Fetch-Site: none`, which the server accepts; web pages are
  refused. `401` (`invalid_grant`) means the code is unknown, used, expired or does not match
  the verifier; `400` and `403` are a refusal.
- The session cookie `subkit_installation_<id>` is HttpOnly, SameSite=Lax and scoped to
  `/cockpit/i/<id>/`. The server marks it `Secure` unless it runs with `NODE_ENV=development`;
  Chromium stores and sends a `Secure` cookie for `http://localhost` and `http://127.0.0.1`, so
  local servers work in both modes.
- The API for an installation lives below `{cockpit_path}api`: `/v1/cockpit/events/stream`
  (SSE, `Last-Event-ID`) and `/v1/attention`. The SSE event name is the event type, for
  example `connector.auth_failed`. `hello` carries `heartbeat_ms`; the shell gives the stream up
  after three missed heartbeats.
- Attention: the server drops its ten-second attention list before it relays an event that can
  change it, so the item is readable when the event arrives. Events about a connector, a
  workflow repair, a failed run, a schedule or a task name their item in `attention_id`. The
  shell reads the list at once; while a named item is missing it asks again after one, three
  and eight seconds, which also covers a server with several processes. Events without a name
  are collected for 400 ms. While the stream is connected the shell reads the list every 60
  seconds as well, so an item that appears without an event is announced within a minute.
- Attention items link to `/cockpit/...`; the shell opens them below the installation path.
- Session end: the server checks the session of every installation stream every three seconds
  and ends the event stream with `session.ended` and `{status, code}`. The shell then reads the
  attention list once and acts on the answer: `401` means the session expired, the profile
  stays and the person signs in again. `403` with the code `installation_revoked` means the
  device was revoked in SubKit: the shell signs the profile out and clears its session data.
- `clients.desktop.feedback_path` names the Cockpit address that opens the feedback dialog.
  “Report a problem” in the app menu, the Help menu and the tray opens it; a server without it
  gets the local diagnostics dialog instead.

## Cockpit bridge

The Cockpit sees `window.subkitDesktop` (protocol version 3) and nothing else of the shell.
Only the main frame of the signed-in server origin may call it.

- `diagnostics()` answers the local diagnostics bundle: app, runtime, operating system, server
  version, connection state and the last ten errors, already cleaned by
  `src/shared/redaction.ts`.
- `captureWindow()` answers a PNG of the Cockpit window as base64, or `null`. Before the
  capture the shell hides password fields, input fields and text areas whose name, id or
  autocomplete hint mentions a password, secret, token or API key, and everything marked
  `data-sensitive` or `data-secret`. It waits for the next paint and answers `null` when the
  mask could not be applied, the window is hidden or the picture is larger than 4 MB.
- `capabilities.screenshot` says what that mask can do: `masksSecretFields: true`,
  `masksVisibleText: false`, `optIn: true`. A secret that the page shows as plain text, for
  example a newly created API key, cannot be told apart from other text and stays in the
  picture. The Cockpit therefore offers the picture unticked, shows it and words its hint
  after these flags.
- `onFeedbackRequested(listener)` lets the page open its feedback dialog when the person picks
  “Report a problem” in a menu. The shell takes the picture first, so the dialog is not in it,
  and loads `feedback_path` only when the page does not listen.
- `sessionEnded()` and `setLocale()` tell the shell that the session ended or the language
  changed.

## Security

- Single instance, `app.enableSandbox()`, `sandbox`, `contextIsolation`, no `nodeIntegration`,
  no `<webview>`, DevTools only in development.
- Navigation and `window.open` stay on the configured server origin. Other `https:` and
  `mailto:` links open in the system browser, everything else is dropped.
- Permissions: `notifications` and `clipboard-sanitized-write` for the server origin, nothing
  else. The response headers of the server, including its CSP, are not touched.
- One persistent session partition per server. Profiles live in `profiles.json` in the user
  data folder and hold no secret: the session is an HttpOnly cookie in the cookie jar, which
  the `enableCookieEncryption` fuse encrypts in packaged builds. `src/main/vault.ts` wraps
  `safeStorage` for future secrets and stores nothing today.
- Packaged builds refuse debugging switches, and the fuses in `electron-builder.base.yml` turn
  off `RunAsNode`, `NODE_OPTIONS` and `--inspect`, load only the integrity-checked `app.asar`
  and take the extra privileges away from `file://` (`grantFileProtocolExtraPrivileges: false`).

### Local pages: `subkit-app://shell/`

The shell never loads a page from `file://`. Its own pages (today the connect and settings
screen, which also shows the update state and every sign-in notice) are served from
`subkit-app://shell/`, for example `subkit-app://shell/index.html`. This scheme is internal
and has nothing to do with the link schemes `subkit://` and `subkit-dev://`: the operating
system does not know it, and it is the same in both channels.

- `src/main/index.ts` registers the scheme as standard and secure before the app is ready, so
  the page has a real origin, relative addresses and a working content security policy.
- `src/main/app-protocol.ts` answers it only in the `connect` session. A Cockpit window
  cannot load it.
- `src/shared/app-files.ts` decides what is served: `GET` only, host `shell` without port or
  credentials, and only files below `dist/connect` with a known type (`.html`, `.js`, `.css`,
  `.woff2`, `.png`). Every path segment must start with a letter or a digit, so `..`, hidden
  files, encoded separators and empty segments are refused; there is no directory listing and
  no index guessing. Before a file is read it must be a regular file whose real path is still
  below the real `dist/connect`, so a symbolic link cannot lead out.
- Answers carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and the same
  content security policy as the page: scripts, styles, fonts and images from
  `subkit-app://shell` only, everything else `'none'`.
- The `connect` session cancels every request that does not go to `subkit-app://shell` (the
  developer tools of a development run excepted), the
  preload exposes `window.subkitConnect` only on the connect page, and the main process
  accepts its calls only from that page.

Add a page by putting its files into `dist/connect` in `scripts/build.ts`; a new file type
needs an entry in `src/shared/app-files.ts`.

## Packaging, signing and updates

`electron-builder.base.yml` targets macOS (dmg and zip, arm64 and x64), Windows (NSIS, x64) and
Linux (AppImage and deb). `electron-builder.yml` adds name, bundle id, scheme, artifact names,
notarization and the update feed of the production channel, `electron-builder.dev.yml` those of
the development channel; the schemes live only there because the builder joins lists of an
extended file.

Signed installers are built only by the workflow `.github/workflows/desktop-release.yml`;
[RELEASING.md](RELEASING.md) names the secrets, the first dry run, how to verify a download and
how to roll an update back. Locally only unpacked, unsigned builds for macOS arm64 were made
with `bun run package:dir` and `bun run package:dev`.

The app carries the version of the repository: `bun run bump <version>` in the repository root
writes it into `apps/desktop/package.json` as well, and the release workflow refuses a tag whose
two versions differ.

### Update flow

Updates exist only in a packaged production build that is signed and has a feed.
`scripts/build.ts` decides it when the build is made (`buildUpdates` in `src/shared/updates.ts`):

| `SUBKIT_DESKTOP_UPDATES` | Result |
| --- | --- |
| unset | on when the build is signed and `publish` names an `https` feed, off otherwise |
| `1` | on; the build stops when it is unsigned, has no feed or is a development build |
| `0` | off |

A build counts as signed when the signing identity of its platform is configured: `CSC_LINK`
on macOS, `WIN_CSC_LINK` or the cloud signing service on Windows. Linux has no code signature;
there the release workflow sets `SUBKIT_DESKTOP_SIGNED_RELEASE=1` because the checksum list of
the release is signed. Without updates `electron-updater` is never loaded.
The app checks at start and every six
hours, and on demand from the tray, the Help menu and the settings screen. `src/shared/updates.ts`
holds the states, each with its own text in German and English:

| State | What the person sees | Action |
| --- | --- | --- |
| `disabled` | Updates are not enabled in this build | none, menu items hidden |
| `idle`, `current` | Installed version, or that it is the latest | Check for updates |
| `checking` | Checking for updates | none |
| `available`, `downloading` | Version and progress in percent | none |
| `ready` | Version is downloaded | Restart now, otherwise installed at the next quit |
| `failed` | Check failed, download failed, or the update could not be verified | Check again |

What is verified, as far as `electron-updater` supports it:

- Every platform: the SHA-512 of the downloaded file against the feed metadata, fetched over
  `https`. No downgrade, no prerelease, no web installer.
- Windows: the Authenticode signature of the downloaded installer against the publisher name
  that `electron-builder` writes into `app-update.yml` from the signing certificate
  (`win.verifyUpdateCodeSignature: true`). An unsigned build has no publisher name and skips
  this check, so never publish one.
- macOS: Squirrel.Mac installs an update only when its code signature satisfies the
  designated requirement of the running app, so both need the same Developer ID. An unsigned
  app cannot update itself and reports “could not be verified”.
- Linux: AppImage has the SHA-512 check only. A deb installation is updated by the package
  updater of `electron-updater`, which asks for administrator rights; not exercised.
- No staged rollout: the feed carries no percentage, so every installation sees a release at
  once. The release workflow refuses a feed with one.

### Windows and Linux

Links and autostart are written for all three systems, but only macOS was exercised. On
Windows and Linux a link starts a second instance; the first instance reads the link from
the arguments (`secondInstanceAction`) and the second one quits; an autostart with `--hidden`
while the app already runs opens nothing. At login macOS passes no arguments, so the app asks
the system whether it was opened at login and then starts without a window.
`src/shared/deep-link.test.ts`, `src/shared/channel.test.ts` and `src/shared/autostart.test.ts`
cover that parsing, the protocol registration of a packaged and a development start and the
XDG autostart entry. Not exercised: the registry entry that `setAsDefaultProtocolClient`
writes on Windows, the `x-scheme-handler` entry of the Linux desktop file, the Windows login
item (`executableWillLaunchAtLogin`), the XDG autostart file, the tray on both systems and the
overlay badge on Windows.

## License notices

The connect screen uses Inter with the font stack and the radius scale of the Cockpit (8 px
controls, 12 px cards, 16 px dialogs). The font files come from `@fontsource-variable/inter`
and are copied into `dist/connect/fonts`; the page loads them from `subkit-app://shell/fonts/`
and nothing from the network.

`bun run notices` collects the license text of every package bundled into the main process and
of the bundled font (SIL Open Font License 1.1) and fails when one is missing. Supplements for packages without a license file live in
`vendor/notices/manifest.json`. Notices for Electron, Chromium, Node.js and the macOS update
frameworks live in `vendor/desktop-runtime-notices`; its `scope` names what is not covered yet.
The script also reads `LICENSES.chromium.html` from the installed Electron distribution, copies
it and the Electron license into the package and appends the FFmpeg entry of that file with its
LGPL text, the source revision and the written offer from the manifest.
