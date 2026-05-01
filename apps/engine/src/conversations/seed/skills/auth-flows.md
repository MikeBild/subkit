---
slug: auth-flows
scope: global
title: Auth Flows
description: Built-in auth modes plus the multi-step "login then call" pattern for upstreams without a first-class flow.
activates_when: []
side_effects: read
idempotency: none
maturity: stable
tags: [auth, oauth, security]
version: 3
---

# Auth Flows

sk supports a fixed catalog of first-class auth modes on the
connector itself plus the **multi-step pattern** for everything else
(any "exchange creds for a token first, then call the API" recipe).

## First-class modes

Set on `connector.auth_type` and configured via the credential row:

| `auth_type` | What it does | When to pick it |
|---|---|---|
| `none` | No auth applied | Public APIs |
| `bearer` | `Authorization: Bearer <token>` | OAuth bearer tokens, GitHub PATs, Linear keys |
| `header` | Free-form headers from the credential | API keys (`x-api-key`), Hasura admin secret, **static AppSync Cognito IdToken** |
| `query` | API key in the URL query string | Older REST APIs (legacy) |
| `basic` | `Authorization: Basic <base64>` | HTTP basic auth |
| `oauth2` | OAuth2 token flow with inline refresh | Anything OAuth2 — covers ALL grant types below |
| `aws_sigv4` | Sign each request with AWS Signature V4 | AppSync IAM, DynamoDB, API Gateway IAM, every-other-AWS-service |

## OAuth2 grant types

Set `oauth.grant_type` on the connector config:

| `grant_type` | Endpoint shape | Typical providers |
|---|---|---|
| `authorization_code` | RFC 6749 §4.1, browser redirect + callback | GitHub, Google, Linear, Monday |
| `client_credentials` | RFC 6749 §4.4, machine-to-machine | Auth0 Management API |
| `password` | RFC 6749 §4.3, username + password | Auth0 / Keycloak / Okta password login |
| `cognito_user_password` | AWS Cognito `InitiateAuth` (proprietary JSON) | AWS AppSync, AWS API Gateway with Cognito authorizer |

All four go through the same inline-refresh path: when the access token
is within 60 seconds of expiry, the driver calls the refresh endpoint
**before** the request goes out, then writes the new token + new
expiry back to `connector_credentials`. The applied auth method is
observable on `request_meta.connector.auth_method` (`oauth2_static` /
`oauth2_refreshed`).

### `cognito_user_password` specifics

Cognito's `InitiateAuth` is **not** OAuth2. The driver handles the
divergence transparently:

- POSTs `{ AuthFlow: "USER_PASSWORD_AUTH", ClientId, AuthParameters: { USERNAME, PASSWORD } }` to `cognito-idp.<region>.amazonaws.com/` with `X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth`.
- Parses `AuthenticationResult.IdToken` (default) or `AccessToken` (set `cognito_use_access_token: true` on connector config).
- Refresh uses `REFRESH_TOKEN_AUTH` — 1h access / 30d refresh.
- Token type is forced to `"none"` so `applyAuthMaterial` emits the raw JWT (`Authorization: <jwt>`, no `Bearer ` prefix). AppSync rejects anything else.

Connector config keys:

| Key | Required | Notes |
|---|---|---|
| `oauth.client_id` | yes | App Client ID with USER_PASSWORD_AUTH enabled |
| `oauth.client_secret` | optional | Required for app clients with a secret; SECRET_HASH is computed automatically |
| `aws_region` | yes | e.g. `eu-central-1`; must match the User Pool |
| `cognito_username` | yes | Email or sub the user logs in with |
| `cognito_use_access_token` | optional | `true` to send AccessToken instead of IdToken (resource APIs) |

**How to collect the credentials (the only path that works):**

1. Set the connector config first via `update_connector_draft`:
   `{ aws_region, oauth: { client_id, grant_type: "cognito_user_password" } }`.
   These are NOT secrets — write them directly. (`token_endpoint`,
   `authorization_endpoint`, `issuer_url` are also non-secret URLs;
   the engine's credential-leak guard allow-lists them.)
2. Call `ask_user_form(type: "password", sensitive: true)` with fields
   `[username, password]`. The harness caches the form output as a
   `cognito_user_password` credential keyed on the conversation.
3. `probe_connector_draft` then mints the IdToken on the fly via
   `runCognitoUserPasswordGrant`, applies it as raw `Authorization`
   header, and the AppSync probe returns 200.
4. `save_connector_draft` persists the IdToken + RefreshToken as a
   regular oauth2 credential row; refresh-worker rotates via
   `REFRESH_TOKEN_AUTH` on stale.

**Anti-pattern**: putting `username` / `password` on
`update_connector_draft.config` (or anywhere on the draft body). The
engine rejects the patch with `credential_must_use_form` and the
operator gets stuck. The masked-form path is the only credential ingress.

Use the built-in `appsync-cognito` template (URL-match auto-selects it
for `*.appsync-api.*.amazonaws.com` hosts) to skip the config dance —
it pre-fills the endpoint, headers, `grant_type`, and
`token_type:"none"`.

## `aws_sigv4` — generic AWS request signing

For AWS services without a first-class sk driver (AppSync IAM,
DynamoDB, API Gateway IAM, EventBridge, SES, SNS, SQS, ...), use
`auth_type: "aws_sigv4"`. The driver signs each outbound request with
the connector's AWS credentials right before dispatch. No token caching
— SigV4 includes a per-request timestamp and runs sub-millisecond.

Connector config keys:

| Key | Required | Notes |
|---|---|---|
| `aws_region` | optional (default `us-east-1`) | e.g. `eu-central-1` |
| `aws_service` | yes | e.g. `appsync`, `execute-api`, `dynamodb`, `s3` |

Credential keys (`mode: "aws_sigv4"`):

| Key | Required | Notes |
|---|---|---|
| `access_key_id` | yes | `AKIA...` for static IAM users; `ASIA...` for STS temporary credentials |
| `secret_access_key` | yes | |
| `session_token` | optional | Required for STS / AssumeRole / IAM Identity Center / EC2 instance-profile credentials |

The driver mutates outgoing headers with `Authorization: AWS4-HMAC-SHA256 Credential=…/<date>/<region>/<service>/aws4_request, SignedHeaders=…, Signature=…` plus `X-Amz-Date` and (for STS-derived creds) `X-Amz-Security-Token`. `auth_method` reports as `"aws_sigv4"` in `request_meta`.

Built-in templates: `appsync-iam` (GraphQL), `aws-apigw-iam` (REST).

## The multi-step pattern (everything else)

When the upstream needs a custom dance sk doesn't speak natively
(SAML→JWT bridges, "POST creds to /login, then use cookie", legacy
session tokens), author it as **two workflow steps**: one to mint the
token, one to use it. This mirrors the pattern the reference
implementation uses for every auth flow.

```json
{
  "steps": [
    {
      "id": "login",
      "kind": "request",
      "connector_id": "<idp_connector>",
      "method": "POST",
      "path": "/oauth/token",
      "body": {
        "grant_type": "password",
        "username": "${cred.idp.username}",
        "password": "${cred.idp.password}"
      }
    },
    {
      "id": "list_orders",
      "kind": "request",
      "connector_id": "<api_connector>",
      "method": "GET",
      "path": "/v1/orders",
      "headers": {
        "Authorization": "Bearer ${scope.login.data.access_token}"
      }
    }
  ]
}
```

The IdP connector is `auth_type: "none"` (no auth on the login call
itself); the API connector is also `auth_type: "none"` because the
auth header comes from the workflow scope, not the credential store.

When to prefer multi-step over a first-class auth mode:
- The token endpoint isn't OAuth-spec-compliant AND the upstream isn't
  Cognito (use a one-off step).
- Multiple downstream APIs share one minted token within the same run
  (avoids N inline-refresh calls).
- The token shape needs custom claims fed from earlier step output.

When to prefer the first-class auth mode:
- Cross-execution token caching matters (saves ~150ms / N requests).
- The credential should be operator-managed in one place (audit, RBAC,
  rotation).
- The minted token is opaque to the workflow author (security boundary).

## Security notes

- Credentials are encrypted at rest with AES-256-GCM bound to
  `credential:<tenant>:<credential_id>` AAD.
- Refresh failures audit as `CREDENTIAL_OAUTH2_REFRESHED result=error`
  with the reason. The stale credential stays in the DB so retries can
  succeed once the upstream comes back.
- Never log tokens. The driver logs `auth_method` + `oauth2_refreshed`
  flags only. `request_meta` carries `credential_id` (the row UUID) so
  audits can correlate without exposing the secret.

## See also

- `graphql-connectors.md` — driver-specific auth conventions for GraphQL
  upstreams (GitHub, Linear, Monday, Hasura, AppSync).
- `http-connectors.md` — header / query / oauth2 conventions for REST.
