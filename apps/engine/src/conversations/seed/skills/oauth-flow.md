---
slug: oauth-flow
scope: global
title: OAuth2 Authorization Flow
description: How to wire an OAuth2 connector in chat. Loaded on demand when a connector template advertises `auth_type: oauth2` or when the user asks to authenticate a saved OAuth2 connector. Covers both template-provided OAuth (where client_id/secret come from the template) and custom OAuth (where the user provides client_id/secret in a masked form).
gates_tools: [authenticate_oauth]
version: 1
auto_load: false
trigger_keywords: [oauth, oauth2, authenticate, authorization code, refresh token, client credentials, sso, single sign-on]
---

# OAuth2 Authorization Flow

OAuth2 connectors authenticate in two phases:

1. **Save the connector** with `save_connector_draft`. The template's OAuth metadata (auth_url, token_url, scopes) is bound automatically.
2. **Run the dance** with `authenticate_oauth`. The agent receives an `authorization_url`, the user opens it in a browser, and the engine persists the access + refresh tokens via the existing `/v1/connectors/:id/oauth/callback` route.

The agent **never** sees raw access or refresh tokens. They are encrypted with AAD `credential:{tenant}:{credential_id}` server-side.

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
