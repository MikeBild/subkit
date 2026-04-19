// Resolver tests against a real Postgres via createTestDb. Covers:
//
//   - cred / connector_url / connector_config / input / scope happy paths
//   - environment trennung
//   - slug_not_found / key_not_found errors
//   - RBAC deny with a real principal
//   - Canary test: a credential value that must never appear in any log line.
//   - resolvePlaceholders walks nested objects / arrays.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { upsertCredential } from "../../../credentials/service.ts";
import { connectors, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { logger } from "../../../logging/logger.ts";
import {
  describeConnectorPlaceholders,
  flattenCredential,
  resolvePlaceholders,
  resolveStringPlaceholders,
} from "../resolver.ts";

const CANARY = "SHOULD-NEVER-APPEAR-IN-LOGS-7a3fcb";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("resolver");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seed(opts: {
  slug: string;
  environment?: "dev" | "prod";
  tokenValue?: string;
  mode?: "bearer" | "header" | "basic" | "query" | "none";
  baseUrl?: string;
  config?: Record<string, unknown>;
}): Promise<{ tenant_id: string; connector_id: string }> {
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-${Math.random().toString(36).slice(2, 10)}`, display_name: "T" })
    .returning();
  const mode = opts.mode ?? "bearer";
  const [conn] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenant!.id,
      slug: opts.slug,
      display_name: opts.slug,
      driver: "http",
      environment: opts.environment ?? "dev",
      auth_type: mode,
      base_url: opts.baseUrl ?? "https://api.example.test",
      config: opts.config ?? {},
    })
    .returning();
  if (mode !== "none") {
    const value =
      mode === "bearer"
        ? { mode: "bearer" as const, token: opts.tokenValue ?? CANARY }
        : mode === "header"
          ? {
              mode: "header" as const,
              headers: { "x-api-key": opts.tokenValue ?? CANARY },
            }
          : mode === "basic"
            ? {
                mode: "basic" as const,
                username: "user1",
                password: opts.tokenValue ?? CANARY,
              }
            : {
                mode: "query" as const,
                query: { key: opts.tokenValue ?? CANARY },
              };
    await upsertCredential(
      {
        tenant_id: tenant!.id,
        connector_id: conn!.id,
        environment: opts.environment ?? "dev",
        mode,
        value,
        actor_id: null,
      },
      ctx.db,
    );
  }
  return { tenant_id: tenant!.id, connector_id: conn!.id };
}

describe("resolver — cred", () => {
  test("bearer credential resolves via ${cred.<slug>.token}", async () => {
    const { tenant_id } = await seed({ slug: "bearer1", tokenValue: "sk-live-abc" });
    const r = await resolveStringPlaceholders("Bearer ${cred.bearer1.token}", {
      tenant_id,
      environment: "dev",
      db: ctx.db,
    });
    expect(r.unresolved).toEqual([]);
    expect(r.value).toBe("Bearer sk-live-abc");
    expect(r.placeholders_used).toEqual(["${cred.bearer1.token}"]);
  });

  test("header credential exposes each header key as a field", async () => {
    const { tenant_id } = await seed({
      slug: "hdr1",
      mode: "header",
      tokenValue: "key-val-42",
    });
    const r = await resolveStringPlaceholders("${cred.hdr1.x-api-key}", {
      tenant_id,
      environment: "dev",
      db: ctx.db,
    });
    expect(r.value).toBe("key-val-42");
  });

  test("basic credential exposes username + password fields", async () => {
    const { tenant_id } = await seed({
      slug: "b1",
      mode: "basic",
      tokenValue: "pw-secret",
    });
    const r = await resolveStringPlaceholders(
      "user=${cred.b1.username} pw=${cred.b1.password}",
      { tenant_id, environment: "dev", db: ctx.db },
    );
    expect(r.value).toBe("user=user1 pw=pw-secret");
  });

  test("slug not found produces slug_not_found and leaves text literal", async () => {
    const { tenant_id } = await seed({ slug: "exists" });
    const r = await resolveStringPlaceholders(
      "A=${cred.missing.token} B=${cred.exists.token}",
      { tenant_id, environment: "dev", db: ctx.db },
    );
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0]!.code).toBe("slug_not_found");
    // Remainder still resolved; unresolved token kept literally.
    expect(r.value.startsWith("A=${cred.missing.token}")).toBe(true);
  });

  test("field not present produces key_not_found", async () => {
    const { tenant_id } = await seed({ slug: "bearer2", mode: "bearer" });
    const r = await resolveStringPlaceholders("${cred.bearer2.nonexistent}", {
      tenant_id,
      environment: "dev",
      db: ctx.db,
    });
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0]!.code).toBe("key_not_found");
  });

  test("environment mismatch: dev credential hidden from prod resolver", async () => {
    const { tenant_id } = await seed({
      slug: "env1",
      environment: "dev",
      tokenValue: "dev-only",
    });
    const r = await resolveStringPlaceholders("${cred.env1.token}", {
      tenant_id,
      environment: "prod",
      db: ctx.db,
    });
    expect(r.unresolved[0]!.code).toBe("slug_not_found");
  });
});

describe("resolver — connector url + config", () => {
  test("${connector.<slug>.base_url} resolves to base_url", async () => {
    const { tenant_id } = await seed({
      slug: "urlx",
      baseUrl: "https://api.urlx.test",
      mode: "none",
    });
    const r = await resolveStringPlaceholders(
      "${connector.urlx.base_url}/v1/users",
      { tenant_id, environment: "dev", db: ctx.db },
    );
    expect(r.value).toBe("https://api.urlx.test/v1/users");
  });

  test("${connector.<slug>.config.<path>} walks nested config", async () => {
    const { tenant_id } = await seed({
      slug: "cfg1",
      mode: "none",
      config: { region: "eu-central-1", bucket: { name: "acme-logs" } },
    });
    const r = await resolvePlaceholders(
      {
        region: "${connector.cfg1.config.region}",
        bucket: "${connector.cfg1.config.bucket.name}",
      },
      { tenant_id, environment: "dev", db: ctx.db },
    );
    expect(r.unresolved).toEqual([]);
    expect(r.value).toEqual({ region: "eu-central-1", bucket: "acme-logs" });
  });

  test("missing config path → key_not_found", async () => {
    const { tenant_id } = await seed({
      slug: "cfg2",
      mode: "none",
      config: { region: "us-east-1" },
    });
    const r = await resolveStringPlaceholders(
      "${connector.cfg2.config.missing.deep}",
      { tenant_id, environment: "dev", db: ctx.db },
    );
    expect(r.unresolved[0]!.code).toBe("key_not_found");
  });
});

describe("resolver — input + scope", () => {
  test("${input.<path>} reads from ctx.input", async () => {
    const { tenant_id } = await seed({ slug: "none1", mode: "none" });
    const r = await resolveStringPlaceholders("Hi ${input.user.name}", {
      tenant_id,
      environment: "dev",
      db: ctx.db,
      input: { user: { name: "Ada" } },
    });
    expect(r.value).toBe("Hi Ada");
  });

  test("${scope.<step>.<path>} reads from ctx.scope", async () => {
    const { tenant_id } = await seed({ slug: "none2", mode: "none" });
    const r = await resolveStringPlaceholders("${scope.fetch.data.id}", {
      tenant_id,
      environment: "dev",
      db: ctx.db,
      scope: { fetch: { data: { id: "abc" } } },
    });
    expect(r.value).toBe("abc");
  });

  test("scope path_empty: step not in scope", async () => {
    const { tenant_id } = await seed({ slug: "none3", mode: "none" });
    const r = await resolveStringPlaceholders("${scope.other.data.id}", {
      tenant_id,
      environment: "dev",
      db: ctx.db,
      scope: { fetch: {} },
    });
    expect(r.unresolved[0]!.code).toBe("path_empty");
  });

  test("object / array values serialize to JSON for inline embed", async () => {
    const { tenant_id } = await seed({ slug: "none4", mode: "none" });
    const r = await resolveStringPlaceholders("${input.payload}", {
      tenant_id,
      environment: "dev",
      db: ctx.db,
      input: { payload: { k: 1, arr: [1, 2] } },
    });
    expect(r.value).toBe('{"k":1,"arr":[1,2]}');
  });
});

describe("resolver — escape handling", () => {
  test("$${cred.x.y} is NOT looked up and appears literally", async () => {
    const { tenant_id } = await seed({ slug: "esc1", tokenValue: "visible" });
    const r = await resolveStringPlaceholders(
      "keep $${cred.esc1.token} but sub ${cred.esc1.token}",
      { tenant_id, environment: "dev", db: ctx.db },
    );
    expect(r.value).toBe("keep ${cred.esc1.token} but sub visible");
    // Only the non-escaped one is counted in placeholders_used.
    expect(r.placeholders_used).toEqual(["${cred.esc1.token}"]);
  });
});

describe("resolver — RBAC enforcement", () => {
  test("principal without connector:read → rbac_denied, no value leaked", async () => {
    const { tenant_id, connector_id } = await seed({
      slug: "rbac1",
      tokenValue: "private-abc",
    });
    const lowPrivPrincipal: ResolvedPrincipal = {
      provider: "test",
      kind: "user",
      id: "11111111-1111-1111-1111-111111111111",
      tenant_id,
      roles: [],
      scopes: [],
    };
    const r = await resolveStringPlaceholders("${cred.rbac1.token}", {
      tenant_id,
      environment: "dev",
      db: ctx.db,
      principal: lowPrivPrincipal,
    });
    expect(r.unresolved[0]!.code).toBe("rbac_denied");
    expect(r.value).toContain("${cred.rbac1.token}");
    expect(r.value).not.toContain("private-abc");
    // Reach through connector_id just to make TS happy about unused symbol:
    expect(connector_id).toBeTruthy();
  });
});

describe("resolver — canary redaction (values never appear in logs)", () => {
  test("successful resolution does not log the credential value", async () => {
    const logSpy = mock(() => undefined);
    const mutableLogger = logger as unknown as {
      info: typeof logger.info;
      warn: typeof logger.warn;
      debug: typeof logger.debug;
    };
    const origInfo = mutableLogger.info;
    const origWarn = mutableLogger.warn;
    const origDebug = mutableLogger.debug;
    mutableLogger.info = logSpy as unknown as typeof logger.info;
    mutableLogger.warn = logSpy as unknown as typeof logger.warn;
    mutableLogger.debug = logSpy as unknown as typeof logger.debug;
    try {
      const { tenant_id } = await seed({
        slug: "canary1",
        tokenValue: CANARY,
      });
      const r = await resolveStringPlaceholders("X-${cred.canary1.token}-Y", {
        tenant_id,
        environment: "dev",
        db: ctx.db,
      });
      expect(r.value).toBe(`X-${CANARY}-Y`);
      // Every log call argument must be free of the canary value.
      for (const call of logSpy.mock.calls) {
        const serialised = JSON.stringify(call);
        expect(serialised.includes(CANARY)).toBe(false);
      }
    } finally {
      mutableLogger.info = origInfo;
      mutableLogger.warn = origWarn;
      mutableLogger.debug = origDebug;
    }
  });

  test("failed resolution (slug_not_found) does not log any value (there is none)", async () => {
    const logSpy = mock(() => undefined);
    const mutableLogger = logger as unknown as { warn: typeof logger.warn };
    const origWarn = mutableLogger.warn;
    mutableLogger.warn = logSpy as unknown as typeof logger.warn;
    try {
      const { tenant_id } = await seed({ slug: "only-this", tokenValue: CANARY });
      const r = await resolveStringPlaceholders("${cred.not-seeded.token}", {
        tenant_id,
        environment: "dev",
        db: ctx.db,
      });
      expect(r.unresolved[0]!.code).toBe("slug_not_found");
      // The only canary in this DB belongs to a different slug — it must not
      // leak into logger.warn calls. We also confirm the resolver itself
      // surfaces the token name in its unresolved entry (that's the safe channel).
      const serialised = JSON.stringify(logSpy.mock.calls);
      expect(serialised.includes(CANARY)).toBe(false);
      expect(r.unresolved[0]!.token).toBe("${cred.not-seeded.token}");
    } finally {
      mutableLogger.warn = origWarn;
    }
  });
});

describe("describeConnectorPlaceholders", () => {
  test("returns placeholder tokens the LLM should use", async () => {
    const { tenant_id } = await seed({
      slug: "dsc1",
      mode: "bearer",
      tokenValue: "xxx",
      baseUrl: "https://api.dsc1.test",
      config: { region: "eu" },
    });
    const d = await describeConnectorPlaceholders("dsc1", {
      tenant_id,
      environment: "dev",
      db: ctx.db,
    });
    expect(d.url).toBe("${connector.dsc1.base_url}");
    expect(d.credentials).toEqual(["${cred.dsc1.token}"]);
    expect(d.config).toEqual(["${connector.dsc1.config.region}"]);
  });

  test("missing connector → empty placeholders with null url", async () => {
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({ slug: `t-${Math.random().toString(36).slice(2, 8)}`, display_name: "Empty" })
      .returning();
    const d = await describeConnectorPlaceholders("does-not-exist", {
      tenant_id: tenant!.id,
      environment: "dev",
      db: ctx.db,
    });
    expect(d).toEqual({ url: null, credentials: [], config: [] });
  });
});

describe("flattenCredential — shape mapping for each mode", () => {
  test("bearer → token field", () => {
    expect(flattenCredential("bearer", { mode: "bearer", token: "t" })).toEqual({ token: "t" });
  });
  test("header → one field per header key", () => {
    const flat = flattenCredential("header", {
      mode: "header",
      headers: { Authorization: "A", "x-trace": "B" },
    });
    expect(flat).toEqual({ Authorization: "A", "x-trace": "B" });
  });
  test("basic → username + password", () => {
    const flat = flattenCredential("basic", {
      mode: "basic",
      username: "u",
      password: "p",
    });
    expect(flat).toEqual({ username: "u", password: "p" });
  });
  test("query → one field per query key", () => {
    const flat = flattenCredential("query", {
      mode: "query",
      query: { k1: "v1", k2: "v2" },
    });
    expect(flat).toEqual({ k1: "v1", k2: "v2" });
  });
  test("none → empty", () => {
    expect(flattenCredential("none", { mode: "none" })).toEqual({});
  });
});

describe("resolvePlaceholders — walks nested structures", () => {
  test("resolves inside deeply nested objects and arrays", async () => {
    const { tenant_id } = await seed({
      slug: "deep1",
      tokenValue: "TOP",
    });
    const r = await resolvePlaceholders(
      {
        headers: {
          Authorization: "Bearer ${cred.deep1.token}",
        },
        nested: [{ value: "${cred.deep1.token}" }, "literal"],
        raw: "plain",
      },
      { tenant_id, environment: "dev", db: ctx.db },
    );
    expect(r.unresolved).toEqual([]);
    expect(r.value).toEqual({
      headers: { Authorization: "Bearer TOP" },
      nested: [{ value: "TOP" }, "literal"],
      raw: "plain",
    });
    // deduped — even though the token appears twice
    expect(r.placeholders_used).toEqual(["${cred.deep1.token}"]);
  });
});
