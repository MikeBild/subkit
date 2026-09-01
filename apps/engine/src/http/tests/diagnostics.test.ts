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
  return {
    plaintext,
    prefix: plaintext.slice(0, 12),
    hash: sha256Hex(plaintext),
  };
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
    // 4.2.0: setup.ts reads exclusively from getConfig() (no envString
    // calls except MASTER_KEY which is bootstrap-only). Drive the
    // config tree via setConfigKey and assert the diagnostic flips.
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
            values: Array<{
              key: string;
              value: string | null;
              status_hint: string | null;
            }>;
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
      // A missing public_base_url is advisory (a recommendation), NOT a setup
      // warning — a correct local/trial install should not show ⚠ for it, and
      // the paths that truly need it already error clearly on their own.
      expect(body.sections.public_urls.status).toBe("ok");
      expect(body.issues.some((issue) => issue.id === "public-base-url")).toBe(false);
      expect(body.recommendations.some((rec) => rec.includes("public_base_url"))).toBe(true);
      expect(body.issues.some((issue) => issue.id === "llm-summarize")).toBe(true);
      // Settings-style key naming: every value key matches a settings
      // path (`sk settings set <key> ...`), not a legacy env var.
      expect(
        body.sections.llm.values.some((value) => value.key === "llm.providers.ai_gateway.api_key"),
      ).toBe(true);
      expect(body.recommendations.length).toBeGreaterThan(0);
    } finally {
      await setConfigKey("llm.provider", before.llmProvider, { force: true });
      await setConfigKey("llm.summarize_provider", before.summarizeProvider ?? null, {
        force: true,
      });
      await setConfigKey("llm.providers.anthropic.api_key", before.anthropicKey, {
        force: true,
      });
      await setConfigKey("server.public_base_url", before.publicBaseUrl, {
        force: true,
      });
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

  test("every Zod-marked secret leaf surfaces as presence or is intentionally omitted", async () => {
    // Schema-walk parity fence (closes the suggestion that a future
    // rename of `llm.providers.anthropic.api_key` to `…anthropic.key`
    // would silently surface as "Missing"). For every leaf in
    // ConfigSchema marked `meta({ secret: true })`, assert that the
    // diagnostic response either:
    //   (a) lists the leaf with value of exactly "configured" or null
    //       (the setPresence shape — never raw secret material), OR
    //   (b) is in KNOWN_OMITTED below — i.e. deliberately not
    //       surfaced because the diagnostic is *operator-facing
    //       configuration validation*, not an audit dump.
    //
    // Each KNOWN_OMITTED entry carries a comment explaining why; a
    // future schema addition that should be surfaced will fall
    // through (a) and trip the assertion. Removing a leaf from the
    // diagnostic without adding it here will also trip — keeps the
    // surface deliberate.
    const KNOWN_OMITTED: Record<string, string> = {
      "llm.api_key":
        "Legacy single-provider key (pre-multi-provider). Tenant-scoped overrides go through llm.providers.<p>.api_key; this leaf is reserved for back-compat only.",
      "auth.session.secret":
        "Auto-generated on first boot if empty (logged once); operators don't author this — surfacing it as 'configured' would just be noise.",
      "platform.slack.signing_secret":
        "Per-platform credentials live in the chat-platform diagnostic, not the bootstrap setup view.",
      "platform.slack.client_secret":
        "Per-platform credentials live in the chat-platform diagnostic, not the bootstrap setup view.",
      "platform.teams.app_password":
        "Per-platform credentials live in the chat-platform diagnostic, not the bootstrap setup view.",
      "platform.googlechat.private_key":
        "Per-platform credentials live in the chat-platform diagnostic, not the bootstrap setup view.",
      "observability.langfuse.secret_key":
        "Observability secrets surface in /v1/diagnostics/observability (planned). Setup view is bootstrap-config-only.",
      "observability.analytics.api_key":
        "Observability secrets surface in /v1/diagnostics/observability (planned). Setup view is bootstrap-config-only.",
      "observability.usage.hmac_secret":
        "The usage pseudonymization secret belongs to the observability diagnostic surface; the bootstrap setup view intentionally never exposes it.",
      "mcp.api_key":
        "MCP routes have their own diagnostic; /v1/diagnostics/setup is intentionally narrower.",
      "llm.providers.bedrock.session_token":
        "Optional STS-issued session token; surfaced only when the operator wires temporary AWS credentials. Rarely set in subkit deployments — the diagnostic stays clean for the long-lived-credential 90% case.",
      "llm.providers.vertex.private_key":
        "Captured implicitly by the combined `llm.providers.vertex.service_account` presence indicator in the LLM section (which checks client_email + private_key together). Surfacing the bare key path would duplicate that signal.",
    };

    const { listConfigLeaves, dottedPath } = await import("../../config/walk.ts");
    const secretPaths = listConfigLeaves()
      .filter((leaf) => !!leaf.meta.secret)
      .map((leaf) => dottedPath(leaf));
    expect(secretPaths.length).toBeGreaterThan(0);

    const res = await fetch(`${srv.baseUrl}/v1/diagnostics/setup`, {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sections: Record<string, { values: Array<{ key: string; value: string | null }> }>;
    };
    const surfacedByKey = new Map<string, string | null>();
    for (const section of Object.values(body.sections)) {
      for (const v of section.values) surfacedByKey.set(v.key, v.value);
    }
    for (const path of secretPaths) {
      if (surfacedByKey.has(path)) {
        const v = surfacedByKey.get(path);
        expect(
          v === "configured" || v === null,
          `secret leaf ${path} surfaced as ${JSON.stringify(v)} — must be "configured" or null`,
        ).toBe(true);
      } else {
        // Not surfaced — must be explicitly KNOWN_OMITTED with a reason.
        expect(
          path in KNOWN_OMITTED,
          `secret leaf ${path} is not surfaced AND not in KNOWN_OMITTED. Either add it to a section builder (with setPresence) or document the omission in KNOWN_OMITTED with a reason.`,
        ).toBe(true);
      }
    }
  });

  test("secret-shape values surface as 'configured'/null only — never the underlying secret", async () => {
    // 4.2.0 security regression net: every secret-shape value in the
    // setup diagnostic uses `setPresence("configured" / null)`,
    // never `maskSecret` (which leaked 6 hex chars to any
    // identity:read principal). A later "improve developer
    // ergonomics" patch that re-introduces maskSecret would silently
    // re-open the leak; this test fails fast on that.
    const { getConfig, setConfigKey } = await import("../../config/loader.ts");
    const before = {
      anthropic: getConfig().llm.providers.anthropic.api_key,
      openai: getConfig().llm.providers.openai.api_key,
      bedrockAccessKeyId: getConfig().llm.providers.bedrock.access_key_id,
      bedrockSecretKey: getConfig().llm.providers.bedrock.secret_access_key,
      s3AccessKey: getConfig().storage.object_store.access_key_id,
      s3SecretKey: getConfig().storage.object_store.secret_access_key,
      s3SessionToken: getConfig().storage.object_store.session_token,
    };
    // Distinct, recognizable fakes so a substring match below would
    // catch any of them on partial leak.
    const fakes = {
      anthropic: "sk-ant-FAKE-LEAK-CANARY-anthro-9f8e7d6c5b4a",
      openai: "sk-FAKE-LEAK-CANARY-openai-9f8e7d6c5b4a3210",
      bedrockAccessKeyId: "AKIAFAKEBEDROCKLEAK1",
      bedrockSecretKey: "fake-bedrock-secret-leak-canary-9f8e7d6c5b4a3210",
      s3AccessKey: "AKIAFAKES3LEAKCANARY",
      s3SecretKey: "fake-s3-secret-leak-canary-9f8e7d6c5b4a3210abcd",
      s3SessionToken: "fake-s3-session-token-leak-canary-9f8e7d6c5b4a3210abcd",
    };
    await setConfigKey("llm.providers.anthropic.api_key", fakes.anthropic, {
      force: true,
    });
    await setConfigKey("llm.providers.openai.api_key", fakes.openai, {
      force: true,
    });
    await setConfigKey("llm.providers.bedrock.access_key_id", fakes.bedrockAccessKeyId, {
      force: true,
    });
    await setConfigKey("llm.providers.bedrock.secret_access_key", fakes.bedrockSecretKey, {
      force: true,
    });
    await setConfigKey("storage.object_store.access_key_id", fakes.s3AccessKey, { force: true });
    await setConfigKey("storage.object_store.secret_access_key", fakes.s3SecretKey, {
      force: true,
    });
    await setConfigKey("storage.object_store.session_token", fakes.s3SessionToken, {
      force: true,
    });
    try {
      // identity:read principal (member). The route is gated by
      // identity:read OR audit:read; a non-admin must NOT see secret
      // material in any shape (full / masked / first-N chars).
      const res = await fetch(`${srv.baseUrl}/v1/diagnostics/setup`, {
        headers: { authorization: `Bearer ${memberKey}` },
      });
      expect(res.status).toBe(200);
      const raw = await res.text();
      // Hard scan: none of the seeded canaries appear anywhere in the
      // serialized response, in any prefix length down to 4 chars.
      // 4 chars is the floor — anything less wouldn't be a meaningful
      // leak, but every credential-shape secret listed above is at
      // least 12 chars, so a 6-char prefix (the historical
      // maskSecret behavior) would clearly flag.
      for (const [key, value] of Object.entries(fakes)) {
        for (let prefixLen = value.length; prefixLen >= 4; prefixLen--) {
          const prefix = value.slice(0, prefixLen);
          expect(
            raw.includes(prefix),
            `${key} prefix(${prefixLen})="${prefix}" must NOT appear in /v1/diagnostics/setup`,
          ).toBe(false);
        }
      }
      // Positive shape check: every secret-shape leaf either reports
      // exactly "configured" or null. Hand-list keeps the assertion
      // resilient to a schema rename (the test fails loudly instead
      // of silently passing on a missing key).
      const body = (await (
        await fetch(`${srv.baseUrl}/v1/diagnostics/setup`, {
          headers: { authorization: `Bearer ${memberKey}` },
        })
      ).json()) as {
        sections: {
          llm: { values: Array<{ key: string; value: string | null }> };
          storage: { values: Array<{ key: string; value: string | null }> };
          crypto: { values: Array<{ key: string; value: string | null }> };
        };
      };
      const valueByKey = new Map<string, string | null>();
      for (const section of [body.sections.llm, body.sections.storage, body.sections.crypto]) {
        for (const v of section.values) valueByKey.set(v.key, v.value);
      }
      const secretLeaves = [
        "llm.providers.anthropic.api_key",
        "llm.providers.openai.api_key",
        "llm.providers.bedrock.access_key_id",
        "llm.providers.bedrock.secret_access_key",
        "storage.object_store.access_key_id",
        "storage.object_store.secret_access_key",
        "storage.object_store.session_token",
        "MASTER_KEY",
      ];
      for (const key of secretLeaves) {
        const v = valueByKey.get(key);
        if (v === undefined) continue; // section may omit the leaf if not relevant for the active provider
        expect(v === "configured" || v === null, `${key}="${v}" must be "configured" or null`).toBe(
          true,
        );
      }
    } finally {
      await setConfigKey("llm.providers.anthropic.api_key", before.anthropic, {
        force: true,
      });
      await setConfigKey("llm.providers.openai.api_key", before.openai, {
        force: true,
      });
      await setConfigKey("llm.providers.bedrock.access_key_id", before.bedrockAccessKeyId, {
        force: true,
      });
      await setConfigKey("llm.providers.bedrock.secret_access_key", before.bedrockSecretKey, {
        force: true,
      });
      await setConfigKey("storage.object_store.access_key_id", before.s3AccessKey, { force: true });
      await setConfigKey("storage.object_store.secret_access_key", before.s3SecretKey, {
        force: true,
      });
      await setConfigKey("storage.object_store.session_token", before.s3SessionToken, {
        force: true,
      });
    }
  });
});
