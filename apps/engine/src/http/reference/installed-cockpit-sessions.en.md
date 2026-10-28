---
slug: installed-cockpit-sessions
summary: Install the Cockpit as an app and receive neutral push notifications.
section: operate
order: 2
audience: operator
---
## Installed Cockpit sessions

You can install your workspace's Cockpit as a web app on a phone or computer. It pays off when your team should get notifications by push or share files and text from other apps to SubKit. Afterwards the app has its own address, its own session and its own icon, and it checks the same permissions as the normal Cockpit.

### Create the installation

From a signed-in browser session you create the installation with `POST /v1/cockpit/installations` and an empty JSON object. If one already exists, SubKit reuses it. The request needs the usual browser CSRF token. The response contains the installation address and its manifest address, and the installation gets its own browser session. Your session in the normal Cockpit (root Cockpit) stays active.

There is exactly one installation per active workspace and owner on the current host; another workspace gets its own.

- `GET /v1/cockpit/installations` reads this owner's current installation without issuing a session.
- `DELETE /v1/cockpit/installations/{id}` revokes the installation. The normal Cockpit offers this revocation.

### Session and sign-out

Each app runs under `/cockpit/i/{installationId}/` with its own cookie for exactly that path: HttpOnly, SameSite=Lax and, over HTTPS, also Secure. Under `/cockpit/i/{installationId}/api/v1/` the app reaches the same API as the normal Cockpit. The same handlers, permissions, CSRF checks, tenant-context checks and hosted quotas apply.

The server checks the session's owner, workspace, installation, expiry and revocation. An app session cannot switch workspace and never falls back to the normal Cockpit session. App event streams recheck the session before delivering each chunk.

This is how an app session ends:

- Signing out revokes only the presented session of this app.
- If you revoke the installation in the normal Cockpit, all its sessions become invalid. If you create it again, it gets a new identity; old links do not become valid again.
- Signing in again through OIDC (OpenID Connect, sign-in through an external identity provider) must return exactly the existing owner identity. It never creates an account and never links one by email address.
- An API key cannot renew an app session. Open the normal Cockpit instead and reopen the workspace app from there.

### App name and icon

The app manifest is only available when signed in and has its own ID, scope and start address. It uses the workspace's saved name, the palette and an optional square app icon. The uploaded icon must be square and at least 512 pixels per edge; the branding byte and pixel limits apply. SubKit generates 192 and 512 pixel PNGs from it.

Name, icon and manifest responses are private and never stored in an HTTP cache. Signed-out entry pages stay neutral. The browser or operating system may still keep an installed app's name and icon after sign-out.

### Sharing and files

The app's service worker is a background script with its own scope. It accepts a bounded amount of content that you send through “Share” from other apps, and it shows neutral push messages. It does not cache pages, API responses or private drafts, and it does not queue writes for later.

Shared files and text stay in volatile memory until you explicitly confirm the import. Even then nothing happens on its own: uploading or collecting does not admit the source to knowledge, create a skill, call a model or start a workflow. Sources keep their original references. Local files and clipboard text are stored as a source artifact.

If the sign-in or the worker's volatile receipt is lost, share the content again after signing in or pick the file once more. The app checks file launch, clipboard and native file dialogs at runtime and uses them only after an explicit action by you. It never persists access to files or folders.

### Push in the installed app

You turn on push separately for each app and device. On the explicit preparation step, SubKit creates an encrypted VAPID key pair for your tenant, which the server uses to sign web push messages. Subscriptions are stored encrypted and bound to the installation and its owner.

A message arrives within about a minute when an item that needs attention is new or changes. Unchanged items do not notify again. The message contains only a generic SubKit hint and opens or focuses the app's start page. It never contains branding, private content or approval actions.

When push ends:

- If an idle session expires, push stays on. When you reopen the app, the existing subscription is bound to the new session.
- Push ends on sign-out, on any explicit session revocation and when the installation is revoked.
- Push also ends when the owner is deactivated, the workspace is switched or deleted, and after 30 days without app use.
- Inactive or deleted owners and workspaces receive no new messages.

There are three limits to know. Neutral messages already sent may still arrive after sign-out. The browser's notification permission may apply to all apps on the same origin (scheme, host and port of the address) and is not revoked automatically on sign-out. Path-bound sessions do not create their own origin, so browser storage and local permissions are not separated.

### Push in the normal browser Cockpit

The normal Cockpit at `/cockpit/` can also receive these neutral notifications without an installation. The bell opens the same opt-in. When you turn push on, the browser asks for its permission. SubKit then registers the push-only worker at `/cockpit/sw.js` and binds the subscription to you and your workspace.

The same push routes accept a normal Cockpit session with a CSRF token. SubKit refuses API keys and bearer tokens, meaning credentials sent in the `Authorization` header. Installation paths never fall back to this session.

If an idle session expires, the subscription remains. After your next sign-in it applies to the new session without asking again. It ends:

- on sign-out, on an explicit session revocation or when you turn push off,
- when the workspace is switched or its lifecycle changes,
- when the user is deactivated or deleted,
- when the push endpoint expires or after 30 days without use.

Another user or workspace in the same browser must opt in again. Each device receives at most one message per change. If the installed app is enabled on the device, the message goes to the app and not to the browser tab. Browsers without push in a tab, such as Safari on iOS, offer installation as an app instead.
