// Integration tests for runOAuth2RefreshKeepAliveForTenant.
//
// The sweep only selects candidates and enqueues `connector.refresh-oauth`
// jobs — no IdP traffic — so a capture stub stands in for pg-boss and the
// assertions run entirely against the candidate query.
//
// Coverage:
//   - credential idle past OAUTH2_KEEPALIVE_IDLE_MS on a healthy connector
//     → exactly one send with { tenant_id, credential_id }.
//   - fresh credential → no send.
//   - connector flagged needs_reauth → excluded (refresh token known-dead).
//   - credential without oauth2_refresh_ciphertext (client_credentials_json
//     shape) → excluded.
//   - soft-deleted credential / soft-deleted connector → excluded.
//   - tenant isolation: another tenant's stale credential is untouched.
//   - circuit-open connector with a stale credential → INCLUDED. This pins
//     the deliberate no-circuit-filter decision: the IdP token endpoint is
//     not the broken API endpoint, and keeping the token alive during an
//     API outage is the point of the sweep.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { RefreshOAuthJob } from "../../credentials/oauth2/refresh-worker.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { connectors, credentials, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  OAUTH2_KEEPALIVE_IDLE_MS,
  runOAuth2RefreshKeepAliveForTenant,
} from "../connector-reauth-scan-runner.ts";

// Frozen sweep timestamp — all staleness is expressed relative to NOW, so
// the test never depends on the wall clock (no argless `new Date()`).
const NOW = new Date("2026-06-01T00:00:00.000Z");
const STALE = new Date(NOW.getTime() - OAUTH2_KEEPALIVE_IDLE_MS - 24 * 60 * 60 * 1000);

let db: TestDb;
let tenantId: string;
let otherTenantId: string;

beforeAll(async () => {
  db = await createTestDb("oauth2_keepalive");
  const [t] = await db.db
    .insert(tenants)
    .values({ slug: "t-keepalive", display_name: "Keepalive Tenant" })
    .returning();
  tenantId = t!.id;
  const [t2] = await db.db
    .insert(tenants)
    .values({ slug: "t-keepalive-other", display_name: "Other Tenant" })
    .returning();
  otherTenantId = t2!.id;
});

afterAll(async () => {
  await db.cleanup();
});

function captureBoss(): { boss: Pick<PgBoss, "send">; sent: RefreshOAuthJob[] } {
  const sent: RefreshOAuthJob[] = [];
  const boss = {
    send: async (queue: string, data: object) => {
      expect(queue).toBe("connector.refresh-oauth");
      sent.push(data as RefreshOAuthJob);
      return "job-id";
    },
  } as unknown as Pick<PgBoss, "send">;
  return { boss, sent };
}

async function seedConnectorWithCredential(opts: {
  slug: string;
  tenantIdOverride?: string;
  needs_reauth?: boolean;
  circuit_state?: "closed" | "open";
  connector_deleted?: boolean;
  credential_deleted?: boolean;
  with_refresh_token?: boolean;
  updated_at?: Date;
}): Promise<string> {
  const tenant = opts.tenantIdOverride ?? tenantId;
  const [c] = await db.db
    .insert(connectors)
    .values({
      tenant_id: tenant,
      slug: opts.slug,
      display_name: opts.slug,
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://example.test",
      config: {},
      needs_reauth: opts.needs_reauth ?? false,
      circuit_state: opts.circuit_state ?? "closed",
      ...(opts.connector_deleted ? { deleted_at: NOW } : {}),
    })
    .returning();
  const row = await upsertCredential(
    {
      tenant_id: tenant,
      connector_id: c!.id,
      environment: "dev",
      mode: "oauth2",
      value: { mode: "oauth2", access_token: "at", token_type: "bearer" },
      ...(opts.with_refresh_token !== false ? { oauth2_refresh_token: "rt" } : {}),
      oauth2_expires_at: NOW,
      actor_id: null,
    },
    db.db,
  );
  await db.db
    .update(credentials)
    .set({
      updated_at: opts.updated_at ?? STALE,
      ...(opts.credential_deleted ? { deleted_at: NOW } : {}),
    })
    .where(eq(credentials.id, row.id));
  return row.id;
}

describe("oauth2 refresh keep-alive sweep", () => {
  test("selects exactly the multi-day-idle credentials on live, unflagged connectors", async () => {
    const staleHealthy = await seedConnectorWithCredential({ slug: "ka-stale" });
    const staleCircuitOpen = await seedConnectorWithCredential({
      slug: "ka-circuit-open",
      circuit_state: "open",
    });
    await seedConnectorWithCredential({ slug: "ka-fresh", updated_at: NOW });
    await seedConnectorWithCredential({ slug: "ka-flagged", needs_reauth: true });
    await seedConnectorWithCredential({ slug: "ka-no-rt", with_refresh_token: false });
    await seedConnectorWithCredential({ slug: "ka-cred-deleted", credential_deleted: true });
    await seedConnectorWithCredential({ slug: "ka-conn-deleted", connector_deleted: true });
    const otherTenantStale = await seedConnectorWithCredential({
      slug: "ka-other-tenant",
      tenantIdOverride: otherTenantId,
    });

    const { boss, sent } = captureBoss();
    await runOAuth2RefreshKeepAliveForTenant(tenantId, NOW, db.db, boss);

    const sentIds = sent.map((j) => j.credential_id).sort();
    expect(sentIds).toEqual([staleHealthy, staleCircuitOpen].sort());
    for (const job of sent) {
      expect(job.tenant_id).toBe(tenantId);
    }
    expect(sentIds).not.toContain(otherTenantStale);

    // The other tenant's sweep picks up only its own stale credential.
    const other = captureBoss();
    await runOAuth2RefreshKeepAliveForTenant(otherTenantId, NOW, db.db, other.boss);
    expect(other.sent.map((j) => j.credential_id)).toEqual([otherTenantStale]);
    expect(other.sent[0]!.tenant_id).toBe(otherTenantId);
  });

  test("a failing enqueue is logged and does not abort the sweep", async () => {
    const survivor = await seedConnectorWithCredential({ slug: "ka-survivor" });
    const attempted: string[] = [];
    const boss = {
      send: async (_queue: string, data: object) => {
        attempted.push((data as RefreshOAuthJob).credential_id);
        if (attempted.length === 1) throw new Error("boss down");
        return "job-id";
      },
    } as unknown as Pick<PgBoss, "send">;

    await runOAuth2RefreshKeepAliveForTenant(tenantId, NOW, db.db, boss);
    // The stale credentials from the previous test plus the new one are
    // still candidates (the stub never actually refreshed them). The first
    // send throws; every remaining candidate must still be attempted.
    expect(attempted.length).toBe(3);
    expect(attempted).toContain(survivor);
  });
});
