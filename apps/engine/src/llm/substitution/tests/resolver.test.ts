// Resolver tests against a real Postgres via createTestDb. Covers:
//
//   - cred / connector_url / connector_config / input / scope happy paths
//   - environment trennung
//   - slug_not_found / key_not_found errors
//   - RBAC deny with a real principal
//   - Canary test: a credential value that must never appear in any log line.
//   - resolvePlaceholders walks nested objects / arrays.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { upsertCredential } from "../../../credentials/service.ts";
import { connectors, credentials, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { logger } from "../../../logging/logger.ts";
import {
  describeConnectorPlaceholders,
  flattenCredential,
  resolvePlaceholders,
  resolvePlaceholdersTypePreserving,
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
    .values({ slug: `t-${Math.random().toString(36).slice(2, 10)}`, display_name: "T" }) // allow-random: legacy; review before changing
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
  test(`bearer credential resolves via \${cred.<slug>.token}`, async () => {
    const { tenant_id } = await seed({ slug: "bearer1", tokenValue: "sk-live-abc" });
    const r = await resolveStringPlaceholders(`Bearer \${cred.bearer1.token}`, {
      tenant_id,
      environment: "dev",
      db: ctx.db,
    });
    expect(r.unresolved).toEqual([]);
    expect(r.value).toBe("Bearer sk-live-abc");
    expect(r.placeholders_used).toEqual([`\${cred.bearer1.token}`]);
  });

  test("header credential exposes each header key as a field", async () => {
    const { tenant_id } = await seed({
      slug: "hdr1",
      mode: "header",
      tokenValue: "key-val-42",
    });
    const r = await resolveStringPlaceholders(`\${cred.hdr1.x-api-key}`, {
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
    const r = await resolveStringPlaceholders(`user=\${cred.b1.username} pw=\${cred.b1.password}`, {
      tenant_id,
      environment: "dev",
      db: ctx.db,
    });
    expect(r.value).toBe("user=user1 pw=pw-secret");
  });

  test("slug not found produces slug_not_found and leaves text literal", async () => {
    const { tenant_id } = await seed({ slug: "exists" });
    const r = await resolveStringPlaceholders(`A=\${cred.missing.token} B=\${cred.exists.token}`, {
      tenant_id,
      environment: "dev",
      db: ctx.db,
    });
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0]!.code).toBe("slug_not_found");
    // Remainder still resolved; unresolved token kept literally.
    expect(r.value.startsWith(`A=\${cred.missing.token}`)).toBe(true);
  });

  test("field not present produces key_not_found", async () => {
    const { tenant_id } = await seed({ slug: "bearer2", mode: "bearer" });
    const r = await resolveStringPlaceholders(`\${cred.bearer2.nonexistent}`, {
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
    const r = await resolveStringPlaceholders(`\${cred.env1.token}`, {
      tenant_id,
      environment: "prod",
      db: ctx.db,
    });
    expect(r.unresolved[0]!.code).toBe("slug_not_found");
  });
});

describe("resolver — connector url + config", () => {
  test(`\${connector.<slug>.base_url} resolves to base_url`, async () => {
    const { tenant_id } = await seed({
      slug: "urlx",
      baseUrl: "https://api.urlx.test",
      mode: "none",
    });
    const r = await resolveStringPlaceholders(`\${connector.urlx.base_url}/v1/users`, {
      tenant_id,
      environment: "dev",
      db: ctx.db,
    });
    expect(r.value).toBe("https://api.urlx.test/v1/users");
  });

  test(`\${connector.<slug>.config.<path>} walks nested config`, async () => {
    const { tenant_id } = await seed({
      slug: "cfg1",
      mode: "none",
      config: { region: "eu-central-1", bucket: { name: "acme-logs" } },
    });
    const r = await resolvePlaceholders(
      {
        region: `\${connector.cfg1.config.region}`,
        bucket: `\${connector.cfg1.config.bucket.name}`,
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
    const r = await resolveStringPlaceholders(`\${connector.cfg2.config.missing.deep}`, {
      tenant_id,
      environment: "dev",
      db: ctx.db,
    });
    expect(r.unresolved[0]!.code).toBe("key_not_found");
  });
});

describe("resolver — input + scope", () => {
  test(`\${input.<path>} reads from ctx.input`, async () => {
    const { tenant_id } = await seed({ slug: "none1", mode: "none" });
    const r = await resolveStringPlaceholders(`Hi \${input.user.name}`, {
      tenant_id,
      environment: "dev",
      db: ctx.db,
      input: { user: { name: "Ada" } },
    });
    expect(r.value).toBe("Hi Ada");
  });

  test(`\${scope.<step>.<path>} reads from ctx.scope`, async () => {
    const { tenant_id } = await seed({ slug: "none2", mode: "none" });
    const r = await resolveStringPlaceholders(`\${scope.fetch.data.id}`, {
      tenant_id,
      environment: "dev",
      db: ctx.db,
      scope: { fetch: { data: { id: "abc" } } },
    });
    expect(r.value).toBe("abc");
  });

  test("scope path_empty: step not in scope", async () => {
    const { tenant_id } = await seed({ slug: "none3", mode: "none" });
    const r = await resolveStringPlaceholders(`\${scope.other.data.id}`, {
      tenant_id,
      environment: "dev",
      db: ctx.db,
      scope: { fetch: {} },
    });
    expect(r.unresolved[0]!.code).toBe("path_empty");
  });

  test("object / array values serialize to JSON for inline embed", async () => {
    const { tenant_id } = await seed({ slug: "none4", mode: "none" });
    const r = await resolveStringPlaceholders(`\${input.payload}`, {
      tenant_id,
      environment: "dev",
      db: ctx.db,
      input: { payload: { k: 1, arr: [1, 2] } },
    });
    expect(r.value).toBe('{"k":1,"arr":[1,2]}');
  });

  test(`\${item.<path>} reads from ctx.scope.$item (loop body)`, async () => {
    const { tenant_id } = await seed({ slug: "none5", mode: "none" });
    const r = await resolveStringPlaceholders(`/v2/projects/\${item.id}/resources`, {
      tenant_id,
      environment: "dev",
      db: ctx.db,
      scope: { $item: { id: "abc-123" } },
    });
    expect(r.value).toBe("/v2/projects/abc-123/resources");
    expect(r.unresolved).toEqual([]);
  });

  test("item path_empty: no $item bound (outside loop body)", async () => {
    const { tenant_id } = await seed({ slug: "none6", mode: "none" });
    const r = await resolveStringPlaceholders(`\${item.id}`, {
      tenant_id,
      environment: "dev",
      db: ctx.db,
      scope: {},
    });
    expect(r.unresolved[0]!.code).toBe("path_empty");
    expect(r.value).toContain(`\${item.id}`);
  });

  test("item key_not_found: $item bound but missing key", async () => {
    const { tenant_id } = await seed({ slug: "none7", mode: "none" });
    const r = await resolveStringPlaceholders(`\${item.does_not_exist}`, {
      tenant_id,
      environment: "dev",
      db: ctx.db,
      scope: { $item: { id: "abc" } },
    });
    expect(r.unresolved[0]!.code).toBe("key_not_found");
  });

  test("item key_not_found suggests the closest actual key (did-you-mean)", async () => {
    const { tenant_id } = await seed({ slug: "none7b", mode: "none" });
    // The exact production drift: workflow reads `${item.messageId}` but the
    // Gmail list payload carries `message_id`. The hint must name it.
    const r = await resolveStringPlaceholders(`\${item.messageId}`, {
      tenant_id,
      environment: "dev",
      db: ctx.db,
      scope: { $item: { message_id: "m1", thread_id: "t1" } },
    });
    expect(r.unresolved[0]!.code).toBe("key_not_found");
    expect(r.unresolved[0]!.message).toContain("did you mean 'message_id'");
  });
});

describe("resolver — escape handling", () => {
  test(`$\${cred.x.y} is NOT looked up and appears literally`, async () => {
    const { tenant_id } = await seed({ slug: "esc1", tokenValue: "visible" });
    const r = await resolveStringPlaceholders(
      `keep $\${cred.esc1.token} but sub \${cred.esc1.token}`,
      { tenant_id, environment: "dev", db: ctx.db },
    );
    expect(r.value).toBe(`keep \${cred.esc1.token} but sub visible`);
    // Only the non-escaped one is counted in placeholders_used.
    expect(r.placeholders_used).toEqual([`\${cred.esc1.token}`]);
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
    const r = await resolveStringPlaceholders(`\${cred.rbac1.token}`, {
      tenant_id,
      environment: "dev",
      db: ctx.db,
      principal: lowPrivPrincipal,
    });
    expect(r.unresolved[0]!.code).toBe("rbac_denied");
    expect(r.value).toContain(`\${cred.rbac1.token}`);
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
      const r = await resolveStringPlaceholders(`X-\${cred.canary1.token}-Y`, {
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
      const r = await resolveStringPlaceholders(`\${cred.not-seeded.token}`, {
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
      expect(r.unresolved[0]!.token).toBe(`\${cred.not-seeded.token}`);
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
    expect(d.url).toBe(`\${connector.dsc1.base_url}`);
    expect(d.credentials).toEqual([`\${cred.dsc1.token}`]);
    expect(d.config).toEqual([`\${connector.dsc1.config.region}`]);
  });

  test("missing connector → empty placeholders with null url", async () => {
    const [tenant] = await ctx.db
      .insert(tenants)
      .values({ slug: `t-${Math.random().toString(36).slice(2, 8)}`, display_name: "Empty" }) // allow-random: legacy; review before changing
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
  test("oauth2_client → client_id only; client_secret never surfaces", () => {
    const flat = flattenCredential("oauth2_client", {
      mode: "oauth2_client",
      client_id: "dyn-client-abc",
      client_secret: "dyn-secret-xyz",
    });
    expect(flat).toEqual({ client_id: "dyn-client-abc" });
    expect(JSON.stringify(flat)).not.toContain("dyn-secret-xyz");
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
          Authorization: `Bearer \${cred.deep1.token}`,
        },
        nested: [{ value: `\${cred.deep1.token}` }, "literal"],
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
    expect(r.placeholders_used).toEqual([`\${cred.deep1.token}`]);
  });
});

describe("resolvePlaceholdersTypePreserving — preserves native JSON types", () => {
  test("integer placeholder alone returns number, not string", async () => {
    const { tenant_id } = await seed({ slug: "tp1", mode: "none" });
    const r = await resolvePlaceholdersTypePreserving<Record<string, unknown>>(
      { limit: `\${input.limit}` },
      {
        tenant_id,
        environment: "dev",
        db: ctx.db,
        input: { limit: 7 },
      },
    );
    expect(r.unresolved).toEqual([]);
    expect(r.value).toEqual({ limit: 7 });
    expect(typeof (r.value as { limit: unknown }).limit).toBe("number");
  });

  test("boolean placeholder alone returns boolean", async () => {
    const { tenant_id } = await seed({ slug: "tp2", mode: "none" });
    const r = await resolvePlaceholdersTypePreserving<Record<string, unknown>>(
      { active: `\${input.active}` },
      {
        tenant_id,
        environment: "dev",
        db: ctx.db,
        input: { active: true },
      },
    );
    expect(r.value).toEqual({ active: true });
    expect(typeof (r.value as { active: unknown }).active).toBe("boolean");
  });

  test("object placeholder alone returns object reference, not JSON-stringified", async () => {
    const { tenant_id } = await seed({ slug: "tp3", mode: "none" });
    const r = await resolvePlaceholdersTypePreserving<Record<string, unknown>>(
      { filter: `\${input.filter}` },
      {
        tenant_id,
        environment: "dev",
        db: ctx.db,
        input: { filter: { id: { eq: "abc" } } },
      },
    );
    expect(r.value).toEqual({ filter: { id: { eq: "abc" } } });
    expect((r.value as { filter: unknown }).filter).toEqual({ id: { eq: "abc" } });
  });

  test("array placeholder alone returns array", async () => {
    const { tenant_id } = await seed({ slug: "tp4", mode: "none" });
    const r = await resolvePlaceholdersTypePreserving<Record<string, unknown>>(
      { ids: `\${input.ids}` },
      {
        tenant_id,
        environment: "dev",
        db: ctx.db,
        input: { ids: [1, 2, 3] },
      },
    );
    expect(r.value).toEqual({ ids: [1, 2, 3] });
    expect(Array.isArray((r.value as { ids: unknown }).ids)).toBe(true);
  });

  test("mixed string with placeholder stays string", async () => {
    const { tenant_id } = await seed({ slug: "tp5", mode: "none" });
    const r = await resolvePlaceholdersTypePreserving<Record<string, unknown>>(
      { greeting: `Hi \${input.name}!` },
      {
        tenant_id,
        environment: "dev",
        db: ctx.db,
        input: { name: "Ada" },
      },
    );
    expect(r.value).toEqual({ greeting: "Hi Ada!" });
  });

  test("string placeholder alone returns string", async () => {
    const { tenant_id } = await seed({ slug: "tp6", mode: "none" });
    const r = await resolvePlaceholdersTypePreserving<Record<string, unknown>>(
      { name: `\${input.name}` },
      {
        tenant_id,
        environment: "dev",
        db: ctx.db,
        input: { name: "Ada" },
      },
    );
    expect(r.value).toEqual({ name: "Ada" });
    expect(typeof (r.value as { name: unknown }).name).toBe("string");
  });

  test("nested object recursion preserves types throughout", async () => {
    const { tenant_id } = await seed({ slug: "tp7", mode: "none" });
    const r = await resolvePlaceholdersTypePreserving<Record<string, unknown>>(
      {
        page: { limit: `\${input.limit}`, offset: `\${input.offset}` },
        filters: [`\${input.flag}`, { tag: `\${input.tag}` }],
      },
      {
        tenant_id,
        environment: "dev",
        db: ctx.db,
        input: { limit: 25, offset: 0, flag: true, tag: "active" },
      },
    );
    expect(r.value).toEqual({
      page: { limit: 25, offset: 0 },
      filters: [true, { tag: "active" }],
    });
  });

  test("unresolved placeholder leaves the literal in place", async () => {
    const { tenant_id } = await seed({ slug: "tp8", mode: "none" });
    const r = await resolvePlaceholdersTypePreserving<Record<string, unknown>>(
      { limit: `\${input.limit}` },
      {
        tenant_id,
        environment: "dev",
        db: ctx.db,
        input: {},
      },
    );
    expect(r.unresolved.length).toBeGreaterThan(0);
    expect(r.value).toEqual({ limit: `\${input.limit}` });
  });

  test("null placeholder value survives as null (not empty string)", async () => {
    const { tenant_id } = await seed({ slug: "tp9", mode: "none" });
    const r = await resolvePlaceholdersTypePreserving<Record<string, unknown>>(
      { tag: `\${input.tag}` },
      {
        tenant_id,
        environment: "dev",
        db: ctx.db,
        input: { tag: null },
      },
    );
    expect(r.unresolved).toEqual([]);
    expect(r.value).toEqual({ tag: null });
  });

  test("escape adjacent to a real placeholder still unescapes (mixed path)", async () => {
    const { tenant_id } = await seed({ slug: "tp10", mode: "none" });
    const r = await resolvePlaceholdersTypePreserving<Record<string, unknown>>(
      { template: `$\${input.name} = \${input.name}` },
      {
        tenant_id,
        environment: "dev",
        db: ctx.db,
        input: { name: "Ada" },
      },
    );
    // Mirrors the existing `resolver — escape handling` test: the escape is
    // honored when it sits alongside a real placeholder in the same string.
    expect(r.value).toEqual({ template: `\${input.name} = Ada` });
  });

  test("placeholder + adjacent literal text — single-token detection does NOT trigger", async () => {
    const { tenant_id } = await seed({ slug: "tp11", mode: "none" });
    // Even with `${...}` at start, the trailing text means it's a mixed
    // string and must resolve to a string (not a number).
    const r = await resolvePlaceholdersTypePreserving<Record<string, unknown>>(
      { x: `\${input.n}-suffix` },
      {
        tenant_id,
        environment: "dev",
        db: ctx.db,
        input: { n: 7 },
      },
    );
    expect(r.value).toEqual({ x: "7-suffix" });
    expect(typeof (r.value as { x: unknown }).x).toBe("string");
  });
});

describe("resolver — soft-delete filtering (regression: /v2/v2 double prefix)", () => {
  // Prod 2026-06-11: three soft-deleted `linkedin` rows coexisted with the
  // live one (the partial unique index only governs live rows). One dead row
  // had base_url ending in `/v2`; fetchConnector lacked `deleted_at IS NULL`
  // and an ORDER BY, so `${connector.linkedin.base_url}/v2/userinfo` resolved
  // the dead row → `/v2/v2/userinfo` → 404.

  test("soft-deleted same-slug connector is never resolved — live row wins", async () => {
    const { tenant_id } = await seed({
      slug: "linkedin",
      mode: "none",
      baseUrl: "https://api.linkedin.test",
    });
    // Insert a NEWER soft-deleted duplicate with the poison base_url. If the
    // resolver forgot the deleted_at filter, ORDER BY created_at DESC would
    // deterministically pick this row — the test would fail loudly instead of
    // depending on physical row order.
    await ctx.db.insert(connectors).values({
      tenant_id,
      slug: "linkedin",
      display_name: "linkedin (deleted)",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://api.linkedin.test/v2",
      config: {},
      deleted_at: new Date(), // allow-wall-clock: deleted_at marker, value irrelevant
      created_at: new Date(Date.now() + 60_000), // allow-wall-clock: newer than the live row on purpose
    });

    const r = await resolveStringPlaceholders(`\${connector.linkedin.base_url}/v2/userinfo`, {
      tenant_id,
      environment: "dev",
      db: ctx.db,
    });
    expect(r.unresolved).toEqual([]);
    expect(r.value).toBe("https://api.linkedin.test/v2/userinfo");
  });

  test("connector whose only row is soft-deleted → slug_not_found", async () => {
    const { tenant_id, connector_id } = await seed({
      slug: "gone",
      mode: "none",
      baseUrl: "https://api.gone.test",
    });
    await ctx.db
      .update(connectors)
      .set({ deleted_at: new Date() }) // allow-wall-clock: deleted_at marker, value irrelevant
      .where(eq(connectors.id, connector_id));

    const r = await resolveStringPlaceholders(`\${connector.gone.base_url}`, {
      tenant_id,
      environment: "dev",
      db: ctx.db,
    });
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0]!.code).toBe("slug_not_found");
  });

  test("soft-deleted credential row is not resolved", async () => {
    const { tenant_id, connector_id } = await seed({
      slug: "deadcred",
      mode: "bearer",
      tokenValue: "should-not-resolve",
    });
    // Soft-delete the credential without freeing the unique slot — exactly
    // what a soft-delete writer would leave behind (see oauth2/tests/wait.test.ts).
    await ctx.db
      .update(credentials)
      .set({ deleted_at: new Date() }) // allow-wall-clock: deleted_at marker, value irrelevant
      .where(eq(credentials.connector_id, connector_id));

    const r = await resolveStringPlaceholders(`\${cred.deadcred.token}`, {
      tenant_id,
      environment: "dev",
      db: ctx.db,
    });
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0]!.code).toBe("key_not_found");
    expect(r.value).not.toContain("should-not-resolve");
  });
});
