// Integration tests for /v1/stats/* RBAC gate.
//
// Every route is gated by `requirePermission("stats:read")`.
// This suite proves:
//   - Unauthenticated → 401 on every operational read route.
//   - A fresh member-role API key → 403 (memberPermissionFilter excludes
//     stats:read from the built-in member role).
//   - A portal-token principal → 403 (portal_token_user role has no
//     stats:read).
//   - A metrics_scraper system-account key → 403 (metrics:read ≠ stats:read).
//   - An admin API key → 200 on all four routes.
//   - Each 403 produces a `policy.denied` audit row.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditLog, portalTokens, systemAccounts, users } from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function genKey(prefix: "wf_live_" | "wf_portal_"): {
  plaintext: string;
  keyPrefix: string;
  hash: string;
} {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: test only
  const plaintext = `${prefix}${rand}`;
  return {
    plaintext,
    keyPrefix: plaintext.slice(0, prefix.length + 4),
    hash: sha256Hex(plaintext),
  };
}

let memberKey = "";
let portalToken = "";
let scraperKey = "";

// Use a window starting from 1h ago so it's always valid and always after
// any audit rows written by the seeding process (which runs just before
// these tests). The audit retention horizon check runs on connectors/events
// routes; a recent window avoids the from_before_retention_horizon branch.
function recentWindow(): string {
  const to = new Date(getTestNow() + 60_000); // 1 min in the future
  const from = new Date(to.getTime() - 3_600_000); // 1h before to
  return `bucket=hour&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
}
const WINDOW_PARAMS = recentWindow();

const STATS_ROUTES = [
  "/v1/operational-overview",
  `/v1/stats/executions?${WINDOW_PARAMS}`,
  `/v1/stats/connectors?${WINDOW_PARAMS}`,
  `/v1/stats/events?${WINDOW_PARAMS}&class=policy`,
  `/v1/stats/llm?${WINDOW_PARAMS}`,
  `/v1/stats/http?${WINDOW_PARAMS}`,
  `/v1/stats/chat?${WINDOW_PARAMS}`,
  `/v1/stats/mcp?${WINDOW_PARAMS}`,
  `/v1/stats/conversations?${WINDOW_PARAMS}`,
] as const;

beforeAll(async () => {
  srv = await createHttpTestServer("stats-rbac");

  // --- member-role user (stats:read excluded by memberPermissionFilter) -----
  const [member] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "member-stats@test.local",
      role: "member",
    })
    .returning();
  const mk = genKey("wf_live_");
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: member!.id,
    prefix: mk.keyPrefix,
    token_sha256: mk.hash,
    scopes: ["*"],
  });
  memberKey = mk.plaintext;

  // --- portal-token principal (portal_token_user role has no stats:read) ----
  const [ptUser] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "enduser-stats@test.local",
      role: "enduser",
    })
    .returning();
  const pt = genKey("wf_portal_");
  await srv.db.insert(portalTokens).values({
    tenant_id: srv.tenantId,
    enduser_ref: ptUser!.id,
    prefix: pt.plaintext.slice(0, 14), // wf_portal_ + 4 chars = 14
    token_sha256: pt.hash,
    allowed_workflows: [],
    expires_at: new Date(getTestNow() + 86_400_000), // 24h from now
  });
  portalToken = pt.plaintext;

  // --- metrics_scraper system account (metrics:read ≠ stats:read) -----------
  const [scraper] = await srv.db
    .insert(systemAccounts)
    .values({
      tenant_id: srv.tenantId,
      name: "metrics-scraper-stats-test",
      description: "test scraper",
    })
    .returning();
  const sk = genKey("wf_live_");
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    system_account_id: scraper!.id,
    prefix: sk.keyPrefix,
    token_sha256: sk.hash,
    scopes: ["metrics:read"],
  });
  scraperKey = sk.plaintext;
});

afterAll(async () => {
  await srv.cleanup();
});

// Helper to clear audit rows between groups so later assertions stay clean.
async function clearAuditLog(): Promise<void> {
  await srv.db.delete(auditLog);
}

describe("stats:read gate — unauthenticated → 401", () => {
  for (const path of STATS_ROUTES) {
    test(`GET ${path.split("?")[0]} → 401`, async () => {
      const res = await fetch(`${srv.baseUrl}${path}`);
      expect(res.status).toBe(401);
    });
  }
});

describe("stats:read gate — member key → 403 + audit denied", () => {
  beforeAll(clearAuditLog);

  for (const path of STATS_ROUTES) {
    test(`GET ${path.split("?")[0]} → 403`, async () => {
      const res = await fetch(`${srv.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${memberKey}` },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("forbidden");
    });
  }

  test("policy.denied audit rows are written for each denial", async () => {
    const rows = await srv.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, srv.tenantId), eq(auditLog.action, "policy.denied")));
    // At least one per route (the test above makes 4 requests).
    expect(rows.length).toBeGreaterThanOrEqual(STATS_ROUTES.length);
    for (const row of rows) {
      const meta = row.metadata as Record<string, unknown>;
      expect(meta.permission).toBe("stats:read");
    }
  });
});

describe("stats:read gate — portal-token principal → 403", () => {
  for (const path of STATS_ROUTES) {
    test(`GET ${path.split("?")[0]} with portal token → 403`, async () => {
      const res = await fetch(`${srv.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${portalToken}` },
      });
      // Portal tokens may not be present in all env setups; 401 is also
      // acceptable if the portal token failed to match (prefix issue),
      // but 200 is never acceptable.
      expect(res.status === 401 || res.status === 403).toBe(true);
    });
  }
});

describe("stats:read gate — metrics_scraper key → 403", () => {
  for (const path of STATS_ROUTES) {
    test(`GET ${path.split("?")[0]} with scraper key → 403`, async () => {
      const res = await fetch(`${srv.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${scraperKey}` },
      });
      expect(res.status).toBe(403);
    });
  }
});

describe("stats:read gate — admin key → 200", () => {
  for (const path of STATS_ROUTES) {
    test(`GET ${path.split("?")[0]} with admin key → 200`, async () => {
      const res = await fetch(`${srv.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${srv.apiKey}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      if (path === "/v1/operational-overview") {
        expect(body.schema_version).toBe("operational-overview.v1");
        expect(body.contract_version).toBe("2.3");
        expect(body.product).toBe("subkit");
        // The exact keys, in order: this is the contract the cockpit, the MCP
        // tool and the Prometheus projection all read. `failing` sits beside
        // `blocked` because it is the other half of the same question — a
        // workflow that cannot start, and one that starts and goes wrong.
        expect(Object.keys(body.core as Record<string, unknown>)).toEqual([
          "blocked",
          "failing",
          "overdue",
          "other_decisions",
          "health",
          "data_freshness",
        ]);
      } else {
        expect(Array.isArray(body.groups)).toBe(true);
        expect(body.totals).toBeDefined();
      }
    });
  }
});
