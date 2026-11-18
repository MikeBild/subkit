import { expect, test } from "bun:test";
import { hostedRegistrationPolicyError } from "../hosted-registration-policy.ts";
import { ConfigSchema } from "../schema.ts";
import { findLeafByPath } from "../walk.ts";

function configuration() {
  return {
    queue: { hosted: { execution_concurrency: 1, chat_concurrency: 1, pending_jobs: 10 } },
    server: {
      hosted_rate_limit: {
        tenant_per_month: 10000,
        peer_per_minute: 1000,
        principal_per_minute: 1000,
        tenant_per_minute: 1000,
        global_per_minute: 1000,
      },
    },
    storage: {
      hosted: {
        tenant_bytes: "1000000",
        max_file_bytes: "100000",
        retained_rows_per_resource: 1000,
      },
    },
    database: { url: "postgres://fixture.invalid/fixture" },
    auth: {
      hosted: {
        enabled: true,
        registration_enabled: true,
        admission: {
          tenant_creations_per_minute: 1000,
          retained_tenants: 1000,
          mcp_clients_per_peer_per_minute: 1000,
          mcp_clients_per_minute: 1000,
          retained_mcp_clients: 1000,
        },
      },
    },
  };
}

test("closed registration preserves hosted member login without a billing allowlist", () => {
  expect(
    ConfigSchema.safeParse({
      database: { url: "postgres://fixture.invalid/fixture" },
      auth: { hosted: { enabled: true, registration_enabled: false } },
    }).success,
  ).toBe(true);
});

test("open registration needs no model settings, and leftover operator budget settings are dropped", () => {
  const parsed = ConfigSchema.safeParse({
    ...configuration(),
    llm: { hosted: { enabled: true, tenant_monthly_microunits: "1000000", models: [] } },
  });
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(parsed.data.llm).not.toHaveProperty("hosted");
  expect(findLeafByPath("llm.hosted.enabled")).toBeUndefined();
  expect(hostedRegistrationPolicyError(parsed.data)).toBeNull();
});

test("registration cannot enable without hosted authentication", () => {
  const config = configuration();
  config.auth.hosted.enabled = false;
  expect(ConfigSchema.safeParse(config).success).toBe(false);
});

test("open registration requires positive shared logical storage quotas within the tenant ceiling", () => {
  const config = configuration();
  config.storage.hosted.tenant_bytes = "0";
  expect(ConfigSchema.safeParse(config).success).toBe(false);
  config.storage.hosted.tenant_bytes = "10";
  config.storage.hosted.max_file_bytes = "11";
  expect(ConfigSchema.safeParse(config).success).toBe(false);
});

test("registration requires positive global request limits owned by the operator", () => {
  for (const key of [
    "tenant_per_month",
    "peer_per_minute",
    "principal_per_minute",
    "tenant_per_minute",
    "global_per_minute",
  ] as const) {
    const input = configuration();
    input.server.hosted_rate_limit[key] = 0;
    expect(ConfigSchema.safeParse(input).success).toBe(false);
    expect(findLeafByPath(`server.hosted_rate_limit.${key}`)?.meta.scope).toBe("global");
  }
});

test("registration requires every operator tenant and MCP admission ceiling", () => {
  for (const key of [
    "tenant_creations_per_minute",
    "retained_tenants",
    "mcp_clients_per_peer_per_minute",
    "mcp_clients_per_minute",
    "retained_mcp_clients",
  ] as const) {
    const config = configuration();
    config.auth.hosted.admission[key] = 0;
    expect(ConfigSchema.safeParse(config).success).toBe(false);
  }
});

test("open registration rejects an unconfigured retained resource ceiling", () => {
  const config = configuration();
  config.storage.hosted.retained_rows_per_resource = 0;
  expect(ConfigSchema.safeParse(config).success).toBe(false);
});

test("the accepted Free resource ceiling defaults to one thousand retained rows per resource", () => {
  const config = ConfigSchema.parse({ database: { url: "postgres://fixture.invalid/fixture" } });
  expect(config.storage.hosted.retained_rows_per_resource).toBe(1000);
});
