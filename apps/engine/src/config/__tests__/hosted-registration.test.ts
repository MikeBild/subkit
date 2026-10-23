import { expect, test } from "bun:test";
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
    llm: {
      hosted: {
        enabled: true,
        tenant_monthly_microunits: "1000000",
        global_monthly_microunits: "10000000",
        models: [
          {
            model: "anthropic:billing-model",
            max_context_tokens: 1000,
            max_output_tokens: 100,
            input_usd_per_million_tokens: "3",
            output_usd_per_million_tokens: "15",
            cache_read_usd_per_million_tokens: "0.3",
            cache_write_5m_usd_per_million_tokens: "3.75",
            cache_write_1h_usd_per_million_tokens: "6",
          },
        ],
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

test("open registration requires a complete operator-owned paid-model policy", () => {
  expect(ConfigSchema.safeParse(configuration()).success).toBe(true);
});

for (const field of ["tenant_monthly_microunits", "global_monthly_microunits"] as const) {
  test(`open registration rejects a zero ${field}`, () => {
    const config = configuration();
    config.llm.hosted[field] = "0";
    expect(ConfigSchema.safeParse(config).success).toBe(false);
  });
}

test("malformed money returns validation errors without throwing during refinement", () => {
  const config = configuration();
  config.llm.hosted.global_monthly_microunits = "not-money";
  expect(ConfigSchema.safeParse(config).success).toBe(false);
});

test("registration cannot enable without hosted authentication and model service", () => {
  const config = configuration();
  config.llm.hosted.enabled = false;
  expect(ConfigSchema.safeParse(config).success).toBe(false);
  config.llm.hosted.enabled = true;
  config.auth.hosted.enabled = false;
  expect(ConfigSchema.safeParse(config).success).toBe(false);
});

test("registration rejects empty or duplicate model allowlists", () => {
  const config = configuration();
  config.llm.hosted.models = [];
  expect(ConfigSchema.safeParse(config).success).toBe(false);
  const valid = configuration();
  const model = valid.llm.hosted.models[0];
  if (!model) throw new Error("model fixture missing");
  valid.llm.hosted.models.push({ ...model });
  expect(ConfigSchema.safeParse(valid).success).toBe(false);
});

test("a disabled model is kept but does not count as an allowed model", async () => {
  const { hostedModelAllowed, hostedRegistrationPolicyError } = await import(
    "../hosted-registration-policy.ts"
  );
  const only = configuration();
  const model = only.llm.hosted.models[0];
  if (!model) throw new Error("model fixture missing");
  only.llm.hosted.models = [{ ...model, disabled: true } as typeof model];
  const parsed = ConfigSchema.safeParse(only);
  expect(parsed.success).toBe(false);
  const mixed = configuration();
  mixed.llm.hosted.models.push({
    ...model,
    model: "openai:paused-model",
    disabled: true,
  } as typeof model);
  const accepted = ConfigSchema.safeParse(mixed);
  expect(accepted.success).toBe(true);
  if (!accepted.success) return;
  expect(accepted.data.llm.hosted.models.map((entry) => entry.disabled)).toEqual([undefined, true]);
  expect(hostedRegistrationPolicyError(accepted.data)).toBeNull();
  expect(accepted.data.llm.hosted.models.map(hostedModelAllowed)).toEqual([true, false]);
  expect(hostedModelAllowed({})).toBe(true);
  expect(hostedModelAllowed({ disabled: false })).toBe(true);
});

test("a duplicate stays forbidden even when one copy is disabled", () => {
  const config = configuration();
  const model = config.llm.hosted.models[0];
  if (!model) throw new Error("model fixture missing");
  config.llm.hosted.models.push({ ...model, disabled: true } as typeof model);
  expect(ConfigSchema.safeParse(config).success).toBe(false);
});

test("registration rejects unpriced models and invalid provider caps", () => {
  const config = configuration();
  const model = config.llm.hosted.models[0];
  if (!model) throw new Error("model fixture missing");
  model.input_usd_per_million_tokens = "0";
  expect(ConfigSchema.safeParse(config).success).toBe(false);
  model.input_usd_per_million_tokens = "3";
  model.max_output_tokens = 2000;
  expect(ConfigSchema.safeParse(config).success).toBe(false);
  model.max_output_tokens = 100;
  model.cache_read_usd_per_million_tokens = "unknown";
  expect(ConfigSchema.safeParse(config).success).toBe(false);
});

test("model allowlist is one global editable structural settings leaf", () => {
  const leaf = findLeafByPath("llm.hosted.models");
  expect(leaf?.meta).toMatchObject({ scope: "global", structural: true, runtimeEditable: true });
  expect(leaf?.schema.safeParse(configuration().llm.hosted.models).success).toBe(true);
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
