---
slug: installed-cockpit-sessions
summary: How an installed Cockpit gets and keeps its workspace session.
section: operate
order: 2
audience: operator
---
## Installed Cockpit sessions

An authenticated browser session can create or reuse its workspace installation with
`POST /v1/cockpit/installations` and an empty JSON object. This operation requires the
normal browser CSRF token. It returns the installation address and manifest address,
and issues an independent browser session for that installation. The existing root
Cockpit session remains active. An installation is unique per active workspace and
owner on the current host; another workspace has its own installation identity.
`GET /v1/cockpit/installations` reads that owner's current installation without
issuing a session. The root Cockpit offers installation revocation through
`DELETE /v1/cockpit/installations/{id}`.

Each app uses `/cockpit/i/{installationId}/` and a separate HttpOnly, SameSite=Lax
cookie with that exact path. HTTPS cookies are Secure. Its API facade under
`/cockpit/i/{installationId}/api/v1/` runs the same API handlers, permissions, CSRF,
tenant-context checks and hosted quotas as the normal API. Installation sessions
cannot switch workspace or fall back to the root session. Their owner, workspace,
installation, session expiry and revocation are checked on the server. App event
streams recheck the session before delivering each chunk. Logout revokes only the
presented app session. Revoking the installation from the root Cockpit invalidates
all its sessions; recreation produces a new identity and does not revive old links.
OIDC reauthentication requires the exact existing owner identity and never provisions
or links an account by email. API-key sign-in cannot renew an installed session;
open the normal Cockpit and reopen the workspace app instead.

The authenticated manifest has a distinct ID, scope and start address and uses the
saved workspace name, palette and optional square app icon. Icons are normalized to
192 and 512 pixel PNGs; uploaded sources must be square and at least 512 pixels per
edge, within the existing branding byte and pixel limits. Name, icon and manifest
responses are private and not stored in the HTTP cache. Signed-out entry pages remain
neutral. The browser or operating system may retain an already installed app's name
and icon after logout.

The scoped service worker handles bounded incoming shares and neutral push messages.
It does not cache pages, API responses or private drafts, and does not queue offline
writes. Incoming files and text remain in volatile memory until an explicit import
confirmation. Uploading or collecting a source does not admit it to knowledge, create
a skill, call a model or start a workflow. Sources keep their original references;
local files and clipboard text retain a stored source artifact. If authentication or
the worker's volatile receipt is lost, repeat the share or file selection after login.
File launch, clipboard and native file dialogs require runtime capability checks and
an explicit user action; no file or directory handle is persisted.

Push requires a separate opt-in for the app and device. The explicit preparation
operation creates a tenant-owned encrypted VAPID key pair; subscriptions are encrypted
and bound to the installation and its owner. Idle session expiry does not end push;
reopening the app re-binds the existing device subscription to the new session. Push
ends on logout, any explicit session revocation, installation revocation, owner
deactivation, workspace switch or deletion, and after 30 days without app use.
Inactive or deleted owners and workspaces receive no new sends. A notification is sent
when a new or changed attention item appears, within about a minute; unchanged items
do not notify again. Notifications contain only a generic SubKit attention hint and
focus or open the app root; they contain no workspace branding, private content or
approval actions. Already sent neutral messages may arrive after logout. A browser
notification permission may be shared across apps on the same origin and is not
automatically revoked by logout. Path-bound sessions do not create separate browser
origins or isolate browser storage and local permissions.

The normal browser Cockpit at `/cockpit/` can also receive these neutral notifications
without an installation. The bell opens the same opt-in; turning it on asks for browser
permission, registers the push-only worker at `/cockpit/sw.js` and binds the
subscription to the signed-in user and workspace. The same push routes accept a root
browser session with CSRF; API keys and bearer tokens are refused, and installation
paths never fall back to the root session. Idle session expiry does not end it; signing
in again re-binds the subscription to the new session without asking again. It ends on
logout, explicit session revocation, workspace switch, user deactivation or deletion,
workspace lifecycle, turning it off, an expired endpoint, and after 30 days without use.
Another user or workspace in the same browser must opt in again. Each device receives at
most one notification per attention change; where the installed app is enabled on the
same device, the app is notified and the browser tab is skipped. Browsers without push
support in a tab, such as Safari on iOS, offer the install path instead.

