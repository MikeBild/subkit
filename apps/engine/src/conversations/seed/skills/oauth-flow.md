---
slug: oauth-flow
scope: global
title: OAuth2 Authorization Flow
description: How to wire an OAuth2 connector in chat. Loaded on demand when a connector template advertises `auth_type: oauth2` or when the user asks to authenticate a saved OAuth2 connector. Covers both template-provided OAuth (where client_id/secret come from the template) and custom OAuth (where the user provides client_id/secret in a masked form).
gates_tools: [authenticate_oauth]
activates_when: [{"kind":"intent_keyword","word":"oauth"},{"kind":"intent_keyword","word":"oauth2"},{"kind":"intent_keyword","word":"authenticate"},{"kind":"intent_keyword","word":"authorization code"},{"kind":"intent_keyword","word":"refresh token"},{"kind":"intent_keyword","word":"client credentials"},{"kind":"intent_keyword","word":"sso"},{"kind":"intent_keyword","word":"single sign-on"}]
side_effects: write
idempotency: key_required
maturity: stable
tags: [auth, oauth]
version: 3
---

# OAuth2 Authorization Flow

**Machine-to-machine grants need NO browser.** When the connector's
`config.oauth.grant_type` is `client_credentials_json` (e.g. Xray Cloud),
the engine exchanges the stored `client_id` + `client_secret` for a token
automatically and refreshes it before expiry. The flow is simply:
collect `client_id`/`client_secret` via `ask_user_form` → `probe_connector_draft`
(the probe mints the token inline and verifies the credentials) → save.
`authenticate_oauth` on such a connector mints immediately and returns
success — never tell the user to open a browser for this grant.

Browser-based OAuth2 connectors authenticate in two phases:

1. **Save the connector** with `save_connector_draft`. The template's OAuth metadata (auth_url, token_url, scopes) is bound automatically.
2. **Run the dance** with `authenticate_oauth`. The agent receives an `authorization_url` AND a `redirect_uri`. Surface BOTH to the user — they must add the `redirect_uri` to their OAuth provider's allowed-redirects allowlist (Google Cloud Console, GitHub OAuth app settings, Slack app config, etc.) BEFORE opening the authorization URL. After authorization the engine persists the access + refresh tokens via the global `/v1/oauth/callback` route.

The agent **never** sees raw access or refresh tokens. They are encrypted with AAD `credential:{tenant}:{credential_id}` server-side.

The `redirect_uri` is synthesized server-side from the engine's `server.public_base_url` plus the fixed path `/v1/oauth/callback`. There is one redirect URI per engine instance, NOT per connector — the same URL is reused for every OAuth2 connector. **Never author a `redirect_uri` yourself**: omit it from `save_connector_draft` payloads and from `update_connector_draft` config patches. The engine ignores connector-config `redirect_uri` values and only uses its own synthesized one.

## Template-provided OAuth (e.g. Slack, Google, GitHub)

```
1. start_connector_from_template({ template_id })
2. probe_connector_draft   # may return 401 — that's expected
3. save_connector_draft     # connector + template metadata persisted; no credential yet
4. authenticate_oauth({ connector_id, scopes? })
   → returns { authorization_url, state, expires_at }
5. Tell the user: "Open <authorization_url> in your browser to finish authentication."
6. (Browser completes; engine writes the credential row automatically.)
```

## Custom OAuth (BYO client_id / client_secret)

When the template does not pre-fill `client_id` / `client_secret`:

```
1. start_connector_from_description / start_connector_from_template
2. ask_user_form({
     summary: "Enter your OAuth2 client credentials",
     fields: [
       { name: "client_id",     type: "text",     sensitive: false },
       { name: "client_secret", type: "password", sensitive: true  },
     ]
   })
3. save_connector_draft({
     credential: {
       mode: "oauth2",
       client_id, client_secret,
       auth_url?, token_url?, scopes?
     }
   })
4. authenticate_oauth({ connector_id, scopes? })
5. (User completes browser flow; tokens persist.)
```

## Hard rules

- **Never** prose-ask "What's your access token?". OAuth2 access tokens are obtained from the authorization server, not the user.
- **Never** ask the user to name the credential. The credential is keyed on `(tenant_id, connector_id, environment)` and is not user-named.
- If `authenticate_oauth` returns `oauth_not_configured`, either the connector lacks OAuth metadata (missing template) or the credential mode wasn't set to `"oauth2"` at save time. Re-issue `save_connector_draft({ credential: { mode: "oauth2", ... } })` with the missing fields.
- After a successful callback, the user can re-run `probe_connector_draft` (or `probe_connector` against the saved connector) to verify the new credential works.

## Example: authenticate_oauth response

The tool returns the authorization URL, the canonical `redirect_uri` to
add to the OAuth provider's allowlist, and an opaque `state` token the
engine uses to correlate the callback.

```json
{
  "authorization_url": "https://slack.com/oauth/v2/authorize?client_id=4815162342&redirect_uri=https%3A%2F%2Fengine.example%2Fv1%2Foauth%2Fcallback&scope=chat%3Awrite&state=opaque-state-token",
  "redirect_uri": "https://engine.example/v1/oauth/callback",
  "state": "opaque-state-token",
  "expires_at": "2026-04-29T12:34:56Z"
}
```

Tell the user: "Add `<redirect_uri>` to your OAuth app's Allowed Redirect URIs, then open `<authorization_url>` to grant access." Do not paraphrase the URLs — copy them verbatim.

After the user completes the browser flow, a probe should succeed. Use the
step shape below to reference the credential the engine just stored — the
driver injects the access token automatically once `auth_type: oauth2` is
on the connector.

```json
{
  "id": "post_message",
  "kind": "request",
  "method": "POST",
  "connector_id": "<slack_connector_id>",
  "path": "/api/chat.postMessage",
  "body": { "channel": "#alerts", "text": "OAuth wiring verified." }
}
```
