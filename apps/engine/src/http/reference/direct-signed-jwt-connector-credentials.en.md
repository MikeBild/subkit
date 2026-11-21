---
slug: direct-signed-jwt-connector-credentials
summary: Connect APIs like App Store Connect that accept a signed JWT directly.
section: operate
order: 9
audience: operator
---
## Direct signed-JWT connector credentials

Some APIs, such as App Store Connect, expect a JWT signed with your private key instead of a password or OAuth token. You need this chapter when you set up such a service as a connector. Afterwards SubKit creates a fresh token for every request, and your private key sits only encrypted on the connector.

A JWT (JSON Web Token) is a short, signed data package; the recipient verifies it with your public key. Here SubKit sends it directly to the resource API in the `Authorization: Bearer` header. This differs from OAuth `private_key_jwt`: a direct signed JWT never goes to a token endpoint. SubKit creates it for the outbound request, retains it only in memory, and does not place it in a workflow, audit entry, or log.

The connector configuration holds the public signing policy: algorithm (`ES256` or `RS256`), audience, optional issuer, subject and key id. It also holds literal custom claims (fields in the token) and a 60–3600 second lifetime. The connector credential holds only the encrypted private key. SubKit supplies `iat` and `exp`; they cannot be set as custom claims. To rotate a key, replace the credential through the connector's normal credential screen, then verify it with the connector's authenticated test.

The built-in **App Store Connect** template is a direct signed-JWT connector for
`https://api.appstoreconnect.apple.com`. Its policy is fixed to `ES256`, audience
`appstoreconnect-v1`, and a five-minute lifetime.

Add the private `.p8` key as
the credential and configure the public Key ID. For a team key set the App Store
Connect Issuer ID as `issuer`; for an individual key omit `issuer` and set
`subject` to `user`. The first probe is `GET /v1/apps`. Do not configure OAuth,
a token endpoint, or an OAuth client assertion for this connector.

The template discovers endpoints from Apple's official OpenAPI ZIP download.
Discovery accepts a single JSON or YAML specification in an archive, limits
compressed and extracted content to 16 MiB, and rejects ambiguous archives.
The resulting endpoint catalog is available to agents; connector documentation
can also be imported with `POST /v1/connectors/{id}/docs/ingest` using
`source_type: "openapi"` and the extracted specification as `content`.

### Set up a signed-JWT connector

In Cockpit, under **Connectors**, choose **Add connector → From a template → App Store Connect**, then open the
connector's existing edit dialog. Enter the public Key ID and either the Issuer
ID (team key) or Subject `user` (individual key). Paste the private key into the
private-key field, save, and run the connector test. A saved key does not prove
that the provider accepts it; only a successful authenticated test does.

Use an App Store Connect API key that can read the intended apps and TestFlight
resources. A Sign in with Apple key is a different credential. The template
creates no testers, sends no invitations, and cannot bypass Apple's beta review.
It remains unverified in the catalogue until a real provider test has succeeded.

For other providers, the same HTTP or GraphQL connector mode accepts this public
configuration, without an Apple-specific transport or token exchange:

```json
{
  "auth_type": "signed_jwt",
  "config": {
    "signed_jwt": {
      "algorithm": "RS256",
      "audience": "https://api.example.com",
      "issuer": "service-account",
      "subject": "integration",
      "key_id": "provider-key-id",
      "ttl_seconds": 300,
      "claims": { "role": "reader" }
    }
  }
}
```

This is the auth part of a connector definition, not a complete create
request. Set the connector name, driver, environment and base URL as usual.
For GraphQL, set its endpoint through the existing GraphQL configuration. Public
claims must match the provider's documented requirements.

The App Store template fixes algorithm, audience, custom claims and lifetime. To change
them, you must explicitly clear or replace the template binding. SubKit checks public identity or key changes
against existing execution authorities.

Attach or replace the key to an already configured connector through the CLI:

```sh
sk vault attach <connector-id> --mode signed_jwt --json < ./provider-key.p8
```

The CLI reads the file locally and sends its contents only to the authenticated
credential endpoint. The JSON result includes the probe outcome; a failed probe
exits unsuccessfully. `--skip-checks` skips the test and makes no connectivity claim.
Never paste a key into a command argument, connector config, workflow, or chat.
The credential API accepts `{ "mode": "signed_jwt", "private_key": "<PEM>" }`
and returns the credential ID, never the key or a generated token.

Keys must be unencrypted PKCS#8 PEM: P-256 for ES256, or RSA 2048–4096 bits for
RS256. SubKit encrypts stored keys, generates a fresh token for each actual
request attempt, and regenerates tokens after restart without a refresh job.
When setting up a draft, SubKit holds the submitted key only transiently in the protected
credential flow until it is saved; it never ends up in chat messages.
Requests cannot redirect to a different resource, and connector hooks do not see
the generated token. Reflected tokens are removed from provider results.

| Problem | Next action |
| --- | --- |
| Private key is invalid or has the wrong algorithm | Use the matching provider-issued PKCS#8 key. Do not submit a certificate, public key, JWK or generated JWT. |
| Provider returns 401 | Check Key ID, issuer/subject, audience, revoked keys and the engine's clock. Replacing a key does not fix an incorrect identity. |
| Provider returns 403 | Check the API key's provider role and access to the intended resource. |
| Provider redirects or target origin differs | Use the final documented API origin in the connector. Signed requests do not follow redirects. |
| Provider is unavailable | Retry the read-only test after recovery; do not replace a valid key solely for a temporary outage. |
| Key rotation | Update the public identity fields if needed, replace the private-key credential, then rerun the read-only test. Never reuse a previously generated JWT. |

### Rules for agents with signed JWTs

Discover the template before authoring a connector. Configure only public fields
under `config.signed_jwt`. Request the private key through SubKit's existing
sensitive credential form or browser setup handoff. Never request it in free-text
chat, and do not generate, print or store JWTs yourself. The secure form field is
`private_key`; `token` and OAuth `client_secret` are not substitutes.

After saving, read the authenticated probe result and report provider failures
without claiming connectivity. Check fresh build/review state before saying an
invitation can be used. An invitation or any other provider mutation requires its
own authorized workflow; the connector setup test performs only a read.

Use the generated OpenAPI schemas as the machine-readable specification and the template-bound
`app-store-connect-basics` skill for vendor guidance. The generated `/llms/setup.md`,
`/llms/connectors.md`, `/llms/cli.md` and `/llms-full.txt` ship with the engine and
are regenerated from these sources; do not maintain a second auth specification.

