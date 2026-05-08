# Rotating MASTER_KEY

> **Read first:** rotating `MASTER_KEY` invalidates every payload encrypted
> under it. The engine uses AES-256-GCM with no key-id envelope — there is
> no "old key" the engine can fall back to. This document describes what
> breaks, what to recover, and the operator-facing downtime window.

## When you must rotate

- The key value leaked (committed to git, posted in a chat, exfiltrated
  from a backup).
- A regulator / customer requires it on a fixed cadence.
- An incident response demands it.

If only the *engine host* was compromised but the key is unknown to the
attacker (e.g. injected at boot from a secret manager, never on disk),
rotation is not required — credential payloads at rest are useless without
the key.

## Blast radius

`apps/engine/src/crypto/aes-gcm.ts` loads `env.MASTER_KEY` once at boot.
The following stores all hold ciphertext keyed by that single key —
rotation invalidates every row in every store below:

Each row below is a Drizzle pgTable with at least one bytea column written
through `encryptSecret()` and read through `decryptSecret()`. The SQL name
is the value passed as the first arg to `pgTable()` — verified against
the schema file as of writing.

| SQL table | Encrypted column(s) | Schema definition | What's lost |
| --- | --- | --- | --- |
| `credentials` | `ciphertext` (NOT NULL), `oauth2_refresh_ciphertext` | `db/schema/connectors.ts:129` | Static secrets + OAuth access/refresh tokens for every connector instance. |
| `end_user_credentials` | `ciphertext` (NOT NULL) | `db/schema/connectors.ts:155` | Per-end-user OAuth secrets for portal flows. |
| `connector_template_credentials` | `ciphertext` (NOT NULL) | `db/schema/connector_template_credentials.ts` | Tenant-overridden template secrets. |
| `workflow_run_state` | `ciphertext` (NOT NULL) | `db/schema/workflow_run_state.ts` | Reverse-ETL watermarks and tenant-encrypted run state. |
| `webhooks_inbound` | `secret_ciphertext` (NOT NULL) | `db/schema/webhooks.ts:19` | Signing secrets for incoming webhooks (row also holds slug + verifier config). |
| `webhooks_outbound` | `secret_ciphertext` (NOT NULL), `rotating_secret_ciphertext` | `db/schema/webhooks.ts:75` | Signing secrets for outgoing webhooks (row also holds URL config). |
| `chat_workspaces` | `bot_ciphertext` (NOT NULL) | `db/schema/chat.ts:20` | Chat-platform bot tokens (row also holds workspace metadata). |
| `auth_provider_configs` | `config_ciphertext` (nullable) | `db/schema/identity.ts:208` | OIDC client secrets (issuer URL + client_id survive). |
| `tenant_llm_settings` | `llm_provider_credentials_ciphertext` (nullable) | `db/schema/llm.ts` | Tenant LLM provider API keys (model + provider config survive). |

Tables in the bottom two rows hold *operational config* alongside the
encrypted secret. The middle three (`webhooks_inbound` / `webhooks_outbound`
/ `chat_workspaces`) have NOT NULL secret columns paired with config in
the same row — the secret cannot be blanked in place, so rotation forces
a re-create through the engine API.

Tenant-isolation invariant is preserved by AAD binding (`aadFor(tenant_id, …)`),
so a leaked key still requires per-row knowledge to forge — but **legitimate
decrypt also fails after rotation**. There is no key-rotation envelope today.

## Recovery sequence

1. **Freeze writes.** Stop the engine on every host serving the tenant
   pool you're rotating. New encrypts under the old key during the
   transition will be lost.
   ```sh
   ssh ${DROPLET} 'systemctl stop subkit-engine.service'
   ```

2. **Take a database snapshot.** This is the only path back if rotation
   goes wrong.
   ```sh
   ssh ${DROPLET} 'pg_dump -Fc subkit > /opt/subkit/backups/pre-rotate-$(date -u +%Y%m%dT%H%M%SZ).dump'
   ```

3. **Generate the new key + inject via your secret manager.**
   ```sh
   openssl rand -hex 32   # produces 64 hex chars; 32 bytes
   ```
   Update the secret store (Doppler / 1Password / DigitalOcean app-level
   env / `.env` for self-hosters) — never commit to git, never write to
   the config file. `MASTER_KEY` is the one bootstrap env that stays
   outside `subkit.config.json` (see `docs/operations/configuration.md`).

4. **Invalidate every ciphertext keyed by the old MASTER_KEY.** The
   strategy depends on whether the secret column is the row's whole
   purpose or whether the row also holds operational config. Run as a
   single transaction so a partial failure doesn't leave half-rotated
   state. Verify each table name matches your migration before running.
   ```sql
   BEGIN;

     -- Pure secret stores. The row identity is the secret; TRUNCATE drops
     -- the row entirely, then it gets re-issued in step 6.
     TRUNCATE
       credentials,
       end_user_credentials,
       connector_template_credentials,
       workflow_run_state
       CASCADE;

     -- Mixed secret-and-config rows: secret column is NOT NULL so it
     -- cannot be blanked in place. Drop the rows and re-create through
     -- the engine API in steps 6–7. CASCADE clears dependent
     -- subscriptions/deliveries/sessions rows.
     TRUNCATE
       webhooks_inbound,
       webhooks_outbound,
       chat_workspaces
       CASCADE;

     -- Nullable secret columns: blank in place; the row's config
     -- (issuer URL, client_id, model name, etc.) survives. Operators
     -- re-enter just the credential through the engine API.
     UPDATE auth_provider_configs SET config_ciphertext = NULL;
     UPDATE tenant_llm_settings   SET llm_provider_credentials_ciphertext = NULL;

   COMMIT;
   ```
   (If your migration version names a column or table differently,
   correct it before running. The canonical column list is the schema
   grep at the top of this doc.)

5. **Boot the engine on the new key.** Watch the boot log; the crypto
   layer asserts key length / hex shape at module load
   (`apps/engine/src/crypto/aes-gcm.ts:48-53`) and exits non-zero if the
   key is malformed.
   ```sh
   ssh ${DROPLET} 'systemctl start subkit-engine.service'
   ssh ${DROPLET} 'journalctl -u subkit-engine.service --since "1 minute ago" -n 50'
   ```
   `/v1/health` should return `db_connected: true` within 30s.

6. **Re-issue every connector credential.** For each tenant × connector:
   - Regenerate static API keys at the upstream system (Stripe, GitHub,
     etc.) and re-add via `sk connectors credentials set`.
   - Re-run OAuth flows for OAuth-based connectors. The stored refresh
     tokens are gone — there is no silent re-auth path.

7. **Re-create every webhook subscription.** `webhooks_inbound` and
   `webhooks_outbound` were truncated, so the routing rows are also gone.
   - Inbound: re-create each inbound subscription (slug + verifier +
     fresh secret) and update every upstream webhook configuration.
   - Outbound: re-create each outbound subscription (URL + fresh
     signing secret) and update every consumer's verification config.

8. **Re-create every chat-platform workspace.** `chat_workspaces`
   was truncated — every Slack/Teams/Google Chat workspace must be
   re-installed and re-onboarded through the platform's add-app flow.

9. **Re-enter OIDC client secrets and tenant LLM API keys.** These
   tables (`auth_provider_configs`, `tenant_llm_settings`) kept their
   non-secret config; operators just re-enter the redacted credential
   leaf. CLI: `sk settings set auth.oidc.client_secret '"…"'` and
   per-tenant `llm.api_key`.

10. **Verify.** Run `scripts/smoke.sh https://${HOST}` and the
    tenant-scoped integration smoke; expect zero `decrypt_failed`
    `CryptoError` entries in the structured log.

## Downtime window

Step 1 (freeze) → step 5 (boot on new key) is **mandatory downtime** —
typically 5–15 minutes for a single host. Steps 6–9 are
operator-driven re-onboarding and run in parallel with the engine
running normally; tenants will see broken connectors, webhook
signatures, chat-platform integrations, OIDC sign-ins, and tenant LLM
calls until each one is re-issued.

## Why there is no in-engine "rotate" command

The crypto layer is intentionally simple — one key, one algorithm, no
key-id envelope. Adding one is a real refactor (every encrypted column
gains a `key_version` field; the read path must dispatch on it; the
worker pool must hold both keys during a window). Until that lands,
rotation is a redeploy, not a click.

If you need rotation without re-issuing every credential, that is the
work to commission — it is not a runbook task.

## See also

- `apps/engine/src/crypto/aes-gcm.ts` — the encrypt/decrypt primitives.
- `apps/engine/src/env.ts` — how `MASTER_KEY` is loaded and validated.
- `.env.example:18-21` — the warning operators see at first install.
- `docs/operations/configuration.md` — why this stays in env, not config.
