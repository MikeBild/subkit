// Integration tests for /v1/diagnostics/errors.
//
// Drives a real engine via createHttpTestServer, seeds the in-memory
// error ring directly, and asserts that:
//   - the route returns the tenant-scoped tail of the ring
//   - tracing by trace_id narrows
//   - the limit query is honored
//   - audit:read is required (member 403)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { apiKeys, users } from "../../db/schema/index.ts";
import { errorRing } from "../../observability/error-ring.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const TEST_NOW_MS = getTestNow();

let srv: HttpTestServer;
let memberKey = "";
let enduserKey = "";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function newKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

beforeAll(async () => {
  srv = await createHttpTestServer("diagnostics");

  // Seed the ring with one entry for our tenant + one for another
  // tenant. Tenant scoping should hide the other tenant's row.
  errorRing.clear();
  errorRing.record({
    trace_id: "trace-self",
    ts: new Date(TEST_NOW_MS).toISOString(),
    tenant_id: srv.tenantId,
    method: "POST",
    path: "/v1/conversations",
    status: 500,
    code: "internal_error",
    message: "boom self",
    stack: "Error: boom self\n  at handler",
    bucket: "unhandled",
  });
  errorRing.record({
    trace_id: "trace-other",
    ts: new Date(TEST_NOW_MS).toISOString(),
    tenant_id: "00000000-0000-0000-0000-000000000999",
    method: "POST",
    path: "/v1/conversations",
    status: 500,
    code: "internal_error",
    message: "boom other",
    stack: null,
    bucket: "unhandled",
  });

  // Member with no audit:read for the 403 test.
  const [member] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "member-diag@test.local",
      role: "member",
    })
    .returning();
  if (!member) throw new Error("seed member failed");
  const key = newKey();
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: member.id,
    prefix: key.prefix,
    token_sha256: key.hash,
    scopes: ["*"],
  });
  memberKey = key.plaintext;

  const [enduser] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "enduser-diag@test.local",
      role: "enduser",
    })
    .returning();
  if (!enduser) throw new Error("seed enduser failed");
  const enduserApiKey = newKey();
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: enduser.id,
    prefix: enduserApiKey.prefix,
    token_sha256: enduserApiKey.hash,
    scopes: ["*"],
  });
  enduserKey = enduserApiKey.plaintext;
});

afterAll(async () => {
  errorRing.clear();
  await srv.cleanup();
});

function adminHeaders() {
  return {
    authorization: `Bearer ${srv.apiKey}`,
    "content-type": "application/json",
  } as const;
}

describe("/v1/diagnostics/errors", () => {
  test("returns only the caller-tenant ring entries", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/diagnostics/errors?limit=20`, {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ trace_id: string; tenant_id: string; message: string }>;
      total_buffered: number;
    };
    expect(body.total_buffered).toBeGreaterThanOrEqual(2);
    for (const row of body.items) expect(row.tenant_id).toBe(srv.tenantId);
    const traces = body.items.map((r) => r.trace_id);
    expect(traces).toContain("trace-self");
    expect(traces).not.toContain("trace-other");
  });

  test("trace_id query narrows", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/diagnostics/errors?trace_id=trace-self`, {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ trace_id: string }> };
    expect(body.items.length).toBe(1);
    expect(body.items[0]?.trace_id).toBe("trace-self");
  });

  test("audit:read is required — member gets 403", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/diagnostics/errors`, {
      headers: { authorization: `Bearer ${memberKey}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("/v1/diagnostics/setup", () => {
  test("returns operator-facing setup validation for admins", async () => {
    // v3.5: drive the config tree via setConfigKey instead of env vars.
    // Snapshot prior values so we can restore (other tests in the same
    // file rely on default config state).
    const { getConfig, setConfigKey } = await import("../../config/loader.ts");
    const before = {
      llmProvider: getConfig().llm.provider,
      summarizeProvider: getConfig().llm.summarize_provider,
      anthropicKey: getConfig().llm.providers.anthropic.api_key,
      publicBaseUrl: getConfig().server.public_base_url,
    };
    await setConfigKey("llm.provider", "mock", { force: true });
    await setConfigKey("llm.summarize_provider", "anthropic", { force: true });
    await setConfigKey("llm.providers.anthropic.api_key", "", { force: true });
    await setConfigKey("server.public_base_url", "", { force: true });
    // Pre-fix env vars the route still reads directly (PUBLIC_BASE_URL
    // is the only env-driven leaf left in setup.ts as of v3.5; once
    // the buildPublicUrlsSection migrates to getConfig.server.* this
    // can be removed).
    const savedPublicEnv = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    try {
      const res = await fetch(`${srv.baseUrl}/v1/diagnostics/setup`, {
        headers: adminHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        overall_status: "ok" | "warn" | "blocked";
        summary_counts: {
          blockers: number;
          warnings: number;
          sections_blocked: number;
          sections_warn: number;
        };
        sections: {
          llm: {
            status: "ok" | "warn" | "blocked";
            values: Array<{ key: string; value: string | null; status_hint: string | null }>;
          };
          public_urls: {
            status: "ok" | "warn" | "blocked";
          };
        };
        issues: Array<{ id: string; severity: string; detail: string }>;
        recommendations: string[];
      };
      expect(body.overall_status).toBe("blocked");
      expect(body.summary_counts.blockers).toBeGreaterThan(0);
      expect(body.sections.llm.status).toBe("blocked");
      expect(body.sections.public_urls.status).toBe("warn");
      expect(body.issues.some((issue) => issue.id === "llm-summarize")).toBe(true);
      expect(body.issues.some((issue) => issue.id === "public-base-url")).toBe(true);
      expect(body.sections.llm.values.some((value) => value.key === "AI_GATEWAY_API_KEY")).toBe(
        true,
      );
      expect(body.recommendations.length).toBeGreaterThan(0);
    } finally {
      await setConfigKey("llm.provider", before.llmProvider, { force: true });
      await setConfigKey("llm.summarize_provider", before.summarizeProvider ?? null, {
        force: true,
      });
      await setConfigKey("llm.providers.anthropic.api_key", before.anthropicKey, {
        force: true,
      });
      await setConfigKey("server.public_base_url", before.publicBaseUrl, { force: true });
      if (savedPublicEnv === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = savedPublicEnv;
    }
  });

  test("member access works through identity:read", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/diagnostics/setup`, {
      headers: { authorization: `Bearer ${memberKey}` },
    });
    expect(res.status).toBe(200);
  });

  test("identity:read or audit:read is required — enduser gets 403", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/diagnostics/setup`, {
      headers: { authorization: `Bearer ${enduserKey}` },
    });
    expect(res.status).toBe(403);
  });
});
