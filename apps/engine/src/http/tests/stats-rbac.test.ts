import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditLog, portalTokens, systemAccounts, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
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

function recentWindow(): string {
  const to = new Date(getTestNow() + 60_000);
  const from = new Date(to.getTime() - 3_600_000);
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

  const [member] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "member-stats@test.local",
      role_id: await builtinRoleId(srv.db, "member"),
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

  const [ptUser] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "enduser-stats@test.local",
      role_id: await builtinRoleId(srv.db, "enduser"),
    })
    .returning();
  const pt = genKey("wf_portal_");
  await srv.db.insert(portalTokens).values({
    tenant_id: srv.tenantId,
    enduser_ref: ptUser!.id,
    prefix: pt.plaintext.slice(0, 14),
    token_sha256: pt.hash,
    allowed_workflows: [],
    expires_at: new Date(getTestNow() + 86_400_000),
  });
  portalToken = pt.plaintext;

  const [scraper] = await srv.db
    .insert(systemAccounts)
    .values({
      tenant_id: srv.tenantId,
      name: "metrics-scraper-stats-test",
      description: "test scraper",
    })
    .returning();
  const issued = genKey("wf_live_");
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    system_account_id: scraper!.id,
    prefix: issued.keyPrefix,
    token_sha256: issued.hash,
    scopes: ["metrics:read"],
  });
  scraperKey = issued.plaintext;
});

afterAll(async () => {
  await srv.cleanup();
});

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
