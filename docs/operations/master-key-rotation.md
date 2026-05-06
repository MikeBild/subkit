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

| Store | Source | What's lost on rotation |
| --- | --- | --- |
| Connector credentials | `apps/engine/src/credentials/service.ts:256-322` | All static secrets (API keys, basic-auth passwords) and OAuth access/refresh tokens for every connector instance. |
| OAuth refresh worker cache | `apps/engine/src/credentials/token-mint/refresh-worker.ts:70` | Newly minted tokens after rotation; pre-rotation entries become unreadable. |
| Inbound webhook secrets | `apps/engine/src/webhooks/inbound/service.ts:116,426` | Signing secrets used to verify incoming webhook payloads. |
| Outbound webhook secrets | `apps/engine/src/webhooks/outbound/service.ts:87,218,229` | Signing secrets (and rotating secondary secrets) for outbound deliveries. |
| Encrypted workflow state | `apps/engine/src/workflow-state/service.ts:98` | Tenant/workflow-scoped encrypted state values. |
| Identity / chat / connector schemas | `apps/engine/src/db/schema/{identity,chat,connectors}.ts` | OIDC client secrets, chat-platform secrets, connector template overrides. |

Tenant-isolation invariant is preserved by AAD binding (`aadFor(tenant_id, …)`),
so a leaked key still requires per-row knowledge to forge — but **legitimate
decrypt also fails after rotation**. There is no key-rotation envelope today.

## Recovery sequence

1. **Freeze writes.** Stop the engine on every host serving the tenant
   pool you're rotating. New encrypts under the old key during the
   transition will be lost.
   ```sh
   ssh ${DROPLET} 'docker compose -f /opt/subkit/docker-compose.yml \
     -f /opt/subkit/docker-compose.prod.yml stop engine'
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

4. **Truncate the encrypted-at-rest stores.** Run as a single transaction
   so a partial failure doesn't leave half-rotated state. The exact set
   matches the table above; verify against your schema before running.
   ```sql
   BEGIN;
     TRUNCATE
       credentials,
       webhook_inbound_secrets,
       webhook_outbound_secrets,
       workflow_state_encrypted,
       oidc_client_secrets,
       chat_platform_secrets
       CASCADE;
   COMMIT;
   ```
   (Adjust table names to your migration version — the canonical list is
   the call-site grep above.)

5. **Boot the engine on the new key.** Watch the boot log; the crypto
   layer asserts key length / hex shape at module load
   (`apps/engine/src/crypto/aes-gcm.ts:48-53`) and exits non-zero if the
   key is malformed.
   ```sh
   ssh ${DROPLET} 'docker compose -f /opt/subkit/docker-compose.yml \
     -f /opt/subkit/docker-compose.prod.yml up -d engine'
   ```
   `/v1/health` should return `db_connected: true` within 30s.

6. **Re-issue every connector credential.** For each tenant × connector:
   - Regenerate static API keys at the upstream system (Stripe, GitHub,
     etc.) and re-add via `sk connectors credentials set`.
   - Re-run OAuth flows for OAuth-based connectors. The stored refresh
     tokens are gone — there is no silent re-auth path.

7. **Re-issue webhook secrets.**
   - Outbound: re-generate via `sk webhooks outbound rotate-secret` (or
     equivalent route) and update every consumer's verification config.
   - Inbound: re-generate the URL secret and update every upstream
     webhook configuration.

8. **Verify.** Run `scripts/smoke.sh https://${HOST}` and the
   tenant-scoped integration smoke; expect zero `decrypt_failed`
   `CryptoError` entries in the structured log.

## Downtime window

Step 1 (freeze) → step 5 (boot on new key) is **mandatory downtime** —
typically 5–15 minutes for a single droplet. Steps 6 and 7 are
operator-driven re-onboarding and run in parallel with the engine
running normally; tenants will see broken connectors / webhook signatures
until each one is re-issued.

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
