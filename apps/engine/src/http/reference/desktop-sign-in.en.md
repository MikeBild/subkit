---
slug: desktop-sign-in
title: Operate the desktop sign-in
summary: Provide SubKit Desktop to your team and decide which app version your server accepts.
section: operate
order: 11
audience: operator
---
## Operate the desktop sign-in

This chapter is for anyone who runs a SubKit server and wants to offer SubKit Desktop to their team.
Afterwards you know what your server tells the app, which two settings you can set, how the sign-in works and how to revoke a device.
“SubKit Desktop” describes how people use the app.

### What you need

- An engine of version @@DESKTOP_MIN_SERVER_VERSION@@ or later. The update runs the migrations for the app’s sign-in.
- An address with `https://`. The app only connects over `https`; it allows `http` for `localhost` alone.
- A working way to sign in to the Cockpit in the browser. The app uses exactly this sign-in and no API key.
- The app itself. SubKit Desktop runs on a Mac with Apple Silicon and macOS 13 or later and on Windows 10 or 11 (x64). Download it for [Mac](https://github.com/MikeBild/subkit/releases/latest/download/subkit-desktop-mac-arm64.dmg) or [Windows](https://github.com/MikeBild/subkit/releases/latest/download/subkit-desktop-win-x64.exe); both links always serve the newest release. To build and distribute it yourself, see below. The Cockpit as an installed web app works on every system.
- For the local capabilities (files, browser and apps on the Mac) an engine of version @@DESKTOP_MIN_SERVER_VERSION@@ or later. On Windows the app offers no local capabilities, so the server sees no device of a Windows PC.

### What the server tells the app

Before every connection the app reads `GET /.well-known/service-descriptor.json`. The section `clients.desktop` tells it whether and how it can sign in.

```json
{
  "version": "<version>",
  "clients": {
    "desktop": {
      "min_version": "@@DESKTOP_MIN_APP_VERSION@@",
      "login": {
        "start": "/v1/identity/desktop-login/start",
        "session": "/v1/identity/desktop-session",
        "callback": "subkit://callback",
        "callbacks": ["subkit://callback"],
        "code_challenge_methods": ["S256"]
      },
      "feedback_path": "/cockpit?feedback=1",
      "anonymous_feedback_path": "/v1/feedback/anonymous"
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `version` | The version of the engine. The app requires at least @@DESKTOP_MIN_SERVER_VERSION@@. |
| `clients.desktop.min_version` | The oldest app version this server accepts. An older app asks for an update instead of signing in. |
| `clients.desktop.login.start` | The address the app opens in the browser. |
| `clients.desktop.login.session` | The address where the app exchanges its code for a session. |
| `clients.desktop.login.callback` | The target the browser hands back to after the confirmation. |
| `clients.desktop.login.callbacks` | Every target this server accepts. An app whose target is missing does not sign in. |
| `clients.desktop.login.code_challenge_methods` | The accepted methods. There is only `S256`. |
| `clients.desktop.feedback_path` | The Cockpit address that opens the “Report a bug” dialog. |
| `clients.desktop.anonymous_feedback_path` | The route that takes a report before the app is signed in, see “Report a bug”. |

When `clients.desktop` is missing, the app reports the server as too old. When `login` is missing in it, the app reports that the server does not offer the sign-in it needs.

### The two settings

Both are in the Cockpit under **Settings** and apply to the whole engine, without a restart.

| Setting | Shown in the Cockpit as | Default | Effect |
| --- | --- | --- | --- |
| `server.desktop_min_version` | **Minimum desktop app version** | `@@DESKTOP_MIN_APP_VERSION@@` | Published as `clients.desktop.min_version`. Format: three numbers such as `@@SUBKIT_VERSION@@`. |
| `server.desktop_dev_callback` | **Accept desktop development builds** | `false` | Also accepts `subkit-dev://callback` as a target. Outside `NODE_ENV=production` this applies without the setting. |

This is how you raise the minimum version:

1. Distribute the new app to your team first.
2. Set `server.desktop_min_version` to that version.
3. People with an older app read “The server requires at least version … of the app and you have ….” the next time they connect.

The app and the engine both enforce the minimum version. The app checks the published value when it connects. The engine checks the version the app names at sign-in as `app_version`, in three places:

| Place | Answer for an older app or without `app_version` |
| --- | --- |
| `GET /v1/identity/desktop-login/start` | `426` with a page “SubKit Desktop is out of date” that names the minimum version, and the header `X-SubKit-Error: desktop_app_outdated`. No sign-in is started. |
| Confirmation page, when shown and when submitted | The same page with `426`. No code is issued. |
| `POST /v1/identity/desktop-session` | `426` with the code `desktop_app_outdated`. The sign-in code is not consumed. The app shows “This version of the app is too old for this server. …” |

A pre-release such as `@@SUBKIT_VERSION@@-beta.1` counts as older than `@@SUBKIT_VERSION@@`. The check applies to new sign-ins: an older app that is already signed in keeps its session until it expires or you revoke the device. The app names its version itself; the limit keeps honest older apps out and does not replace access control.

Leave `server.desktop_dev_callback` switched off in production. Development builds are called “SubKit Dev”, use the scheme `subkit-dev://` and are meant only for developing the app.

### How the sign-in works

1. The app opens `GET /v1/identity/desktop-login/start` in the browser with a PKCE challenge (`S256`), a `state`, the ID and name of the device, and its version as `app_version`.
2. The engine redirects to the confirmation page. If the person is not signed in in the browser, they sign in as usual first.
3. The page names the device, the workspace and the account. The person selects **Sign in** or **Cancel**.
4. With **Sign in**, the browser hands back to `subkit://callback` with a code. With **Cancel**, it hands back `error=access_denied`.
5. The app exchanges the code for a session with `POST /v1/identity/desktop-session`, its `code_verifier` and its `app_version`. The answer sets an HttpOnly cookie for `/cockpit/i/{installationId}/` and never contains an API key.

What applies:

| Rule | Value |
| --- | --- |
| Validity of the confirmation page | 10 minutes |
| Validity of the code | 60 seconds, usable once. Any attempt consumes it. |
| Binding of the code | To the challenge, the workspace, the person and the device. A new code for the same device invalidates older ones. |
| Limit per address | 30 calls per minute for the start, 30 for the confirmation, 10 for the exchange. After that `429` with `Retry-After`. |
| Exchange from a web page | Refused with `403 cross_origin_rejected`. Only the app itself can exchange. |
| Confirmation from another site | Refused with `403 csrf_rejected`. |

The engine counts the limits in the database. They apply across all engine processes together and survive a restart.

### How long a desktop session lasts

| Rule | Desktop device | Browser and installed web app |
| --- | --- | --- |
| Without use | 30 days. Any request of the app, also the open event stream, starts the period again. | 8 hours |
| At most since the sign-in | 90 days | 24 hours |
| Revoking the device, **Sign out**, a deactivated person | Ended at once | Ended at once |

The cookie of the desktop session lasts 90 days; whether the session still holds is decided by the engine on every request. After it expires the engine answers `401`, and the app asks for a new sign-in in the browser. The periods are fixed and not a setting. Approvals that require a live session of the person also accept the desktop session within these periods.

### View and revoke devices

Every computer is an installation of its own of the kind `desktop` with its own session. The same device ID reuses its installation; a new computer gets a new one.

The Cockpit shows a person’s devices under **Settings** › **Your profile** › **Where are you signed in?** and revokes them there after a question that names the device and the consequence. You can use the same routes directly. They accept a session of the Cockpit, with its CSRF token, and no API key. A person sees and revokes only their own devices with them:

| Route | Does |
| --- | --- |
| `GET /v1/cockpit/installations` | Lists up to 50 of your own installations under `installations`, with `id`, `kind` (`browser` or `desktop`), `device_label`, `created_at`, `last_used_at` (the last request a session of this installation made, else `null`) and `current` (`true` for the installation the request comes from). |
| `DELETE /v1/cockpit/installations/{installationId}` | Revokes the installation. Answers `204`. The session of the normal Cockpit in the browser revokes any of your installations; the session of an installation only itself, otherwise `403 own_installation_only`. |

What the revocation does:

- All sessions of the device end, and its push ends.
- The engine checks the session of open event streams every three seconds. The app therefore learns of the revocation within a few seconds and signs out locally.
- Later requests with the old cookie get `403 installation_revoked`. An expired session gets `401 installation_session_required` instead; the profile then stays in the app, and the person signs in again.
- When the person signs in again on the computer, a new installation is created.

**Revoke installation** in the workspace menu only revokes the installed web app. The dialog says so: desktop devices stay signed in and are signed out under **Settings** › **Your profile**. Each installation is revoked on its own; there is no revocation of all devices at once.

When a person is deactivated, the exchange refuses with `403 user_inactive`.

### Build and distribute the app

Most teams use the signed builds from the [latest release](https://github.com/MikeBild/subkit/releases/latest). This section is for building your own from the repository. The app lives there under `apps/desktop`. A build for distribution is made there with `bun run package`. The repository does not bring the following; you supply it yourself:

| For | What you provide |
| --- | --- |
| Signing for macOS | A Developer ID certificate and the credentials for notarization. |
| Signing for Windows | A code signing certificate (Authenticode) with a timestamp, or a cloud signing service. |
| Updates | A place where you publish versions over `https`, and the decision to enable updates (`SUBKIT_DESKTOP_UPDATES=1` when building). |

Without enabled updates the app shows “Automatic updates are not enabled in this build.” An unsigned app cannot update itself, on macOS or on Windows. None of these values belongs in the repository. The details are in the README file under `apps/desktop`.

### What the audit trail records

| Action | When |
| --- | --- |
| `desktop_login.code_issued` | The person confirmed the device in the browser. |
| `desktop_login.denied` | The person cancelled (`declined_by_user`), or the exchange failed, for example `replayed`, `expired`, `invalid_verifier`, `state_mismatch` or `user_inactive`. |
| `desktop_login.completed` | The app received its session. |
| `cockpit_installation.created` | A new device was created, with `kind`, device ID and name. |
| `cockpit_installation.revoked` | A device was revoked, with the number of sessions ended. |
| `session.revoked` | Per session ended, with the reason `installation_revoked`. |

An exchange with an unknown code only appears in the engine log, not in the audit trail. The Cockpit so far shows the three `desktop_login.*` actions with their technical name.

### If something does not work

| What you see | What to do |
| --- | --- |
| The app reports the server as too old | Check `version` in the service descriptor. The app needs @@DESKTOP_MIN_SERVER_VERSION@@ or later and the section `clients.desktop`. |
| The app reports that the server does not offer the sign-in it needs | The app is a development build and your server does not accept `subkit-dev://callback`, or `login` is missing in the descriptor. |
| `400 invalid_redirect_uri` at the start | The app’s target is not in `callbacks`. Use a production build or switch on `server.desktop_dev_callback`. |
| `401 invalid_grant` at the exchange | The code is unknown, used, expired or does not match the `code_verifier`. The person starts the sign-in again. |
| `429` during the sign-in | Too many attempts from one address. Wait for the time in `Retry-After`. |
| The browser does not return to the app | The system does not know the scheme `subkit://`. Install the app again so that it registers it. |
| `401 browser_session_required` when listing devices | The route accepts only a session of the Cockpit and no API key. |
| `403 own_installation_only` when revoking | The request comes from an installation and names another one. Revoke the other device in the browser. |
| `426 desktop_app_outdated` at sign-in | The app is older than `server.desktop_min_version` or names no version. Update the app. |
