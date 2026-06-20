# Cognito connector reauth — root cause & fix

**Symptom (reported from a live MCP session, `sicharge-appsync` connector).**
`request_connector_reauth` returned a browser sign-in link
(`/v1/connectors/:id/oauth/start?grant=skog_…`). Opening it showed
**"Authorization failed — this link has been used up — ask the assistant for a
fresh link."** A fresh link failed the same way. The connector stayed
`needs_reauth: true`.

## How it was found

SSH'd to the engine droplet (`subkit-engine`, systemd unit `subkit-engine.service`)
and read `journalctl -u subkit-engine` around the reauth attempts:

```
module:"oauth"  action:"oauth.grant_start.dance_failed"
msg:"OAuth dance failed after grant consumed"
error:"unexpected HTTP response status code"          ← the real failure
...
module:"oauth2" action:"oauth2.refresh_error"
error:"cognito InitiateAuth returned 400: NotAuthorizedException: Refresh Token has expired"
```

So the grant token was valid and **consumed**; the OAuth *dance* then threw, and
the handler rendered the misleading "used up" page
(`apps/engine/src/http/routes/connectors/oauth.ts:238`).

## Root cause

`appsync-cognito` is `auth_type: "oauth2"` but its grant is
**`cognito_user_password`** (Cognito `USER_PASSWORD_AUTH` / `InitiateAuth`) — a
*password* grant, **not** a browser authorization-code flow:

- `request_connector_reauth` only special-cased `client_credentials_json`;
  every other OAuth2 grant fell through to the **browser grant link**
  (`mintOAuthStartGrantUrl`).
- `beginConnectorOAuthDance` only special-cased `client_credentials_json`;
  everything else hit `startAuthorizationCode`, which does OIDC discovery /
  authorization-endpoint work against the Cognito `InitiateAuth` endpoint →
  `"unexpected HTTP response status code"`.
- Cognito stores **only the refresh token + username, never the password**
  (`refresh-worker.ts` passes `password: ""` and uses `REFRESH_TOKEN_AUTH`).
  Once the refresh token expires there is nothing to refresh and no endpoint to
  redirect to — the password must be **re-entered**.

## Fix

- **`request_connector_reauth`** (`apps/engine/src/conversations/tools/request-connector-reauth.ts`):
  resolve the grant type up front; route `cognito_user_password` to the existing
  **in-chat credential re-issue** path (the one used for basic/bearer/etc.) — it
  collects `username` + `password` via a masked `ask_user_form` and re-mints via
  `USER_PASSWORD_AUTH`, rotating the credential in place (same connector id;
  dependent workflows untouched). No browser link is ever minted.
- **`beginConnectorOAuthDance`** (`apps/engine/src/connectors/oauth-start.ts`):
  defense-in-depth — throw a clear `BadRequestError` for `cognito_user_password`
  before `startAuthorizationCode`, instead of the opaque
  `"unexpected HTTP response status code"`.
- Regression test: `request-connector-reauth.test.ts` asserts a
  `cognito_user_password` connector returns `method: portal_setup`,
  `mode: credential_re_issue`, `grant_type: cognito_user_password`, and
  **no** `reauth_url`.

## Operator note

The fix takes effect once the droplet rolls to the release that contains it
(`mikebild/subkit:7.2.2`). After upgrade, asking the assistant to reauth
`sicharge-appsync` prompts for the Cognito email + password in chat instead of a
dead browser link.
