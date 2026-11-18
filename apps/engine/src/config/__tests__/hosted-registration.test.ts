import { expect, test } from "bun:test";
import { hostedOperatorModelPolicy } from "../../llm/runtime/hosted-budget-middleware.ts";
import {
  hostedModelAllowed,
  hostedRegistrationPolicyError,
} from "../hosted-registration-policy.ts";
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

test("open registration needs no operator-paid model service", () => {
  expect(ConfigSchema.safeParse(configuration()).success).toBe(true);
  const { llm: _llm, ...withoutHostedModels } = configuration();
  const parsed = ConfigSchema.safeParse(withoutHostedModels);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(parsed.data.llm.hosted).toEqual({
    enabled: false,
    tenant_monthly_microunits: "0",
    global_monthly_microunits: "0",
    models: [],
  });
  expect(hostedRegistrationPolicyError(parsed.data)).toBeNull();
});

test("open registration accepts zero budgets, a disabled model service and an empty model list", () => {
  for (const field of ["tenant_monthly_microunits", "global_monthly_microunits"] as const) {
    const config = configuration();
    config.llm.hosted[field] = "0";
    expect(ConfigSchema.safeParse(config).success).toBe(true);
  }
  const disabled = configuration();
  disabled.llm.hosted.enabled = false;
  disabled.llm.hosted.models = [];
  expect(ConfigSchema.safeParse(disabled).success).toBe(true);
});

test("malformed money returns validation errors without throwing during refinement", () => {
  const config = configuration();
  config.llm.hosted.global_monthly_microunits = "not-money";
  expect(ConfigSchema.safeParse(config).success).toBe(false);
});

test("registration cannot enable without hosted authentication", () => {
  const config = configuration();
  config.auth.hosted.enabled = false;
  expect(ConfigSchema.safeParse(config).success).toBe(false);
});

test("a disabled or duplicate model never admits an operator-paid call", () => {
  const config = configuration();
  const model = config.llm.hosted.models[0];
  if (!model) throw new Error("model fixture missing");
  config.llm.hosted.models = [
    { ...model, disabled: true } as typeof model,
    { ...model, model: "openai:twice" },
    { ...model, model: "openai:twice" },
    { ...model, model: "openai:priced" },
  ];
  const parsed = ConfigSchema.safeParse(config);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  const hosted = parsed.data.llm.hosted;
  expect(hosted.models.map(hostedModelAllowed)).toEqual([false, true, true, true]);
  expect(hostedModelAllowed({})).toBe(true);
  expect(hostedModelAllowed({ disabled: false })).toBe(true);
  expect(hostedOperatorModelPolicy(hosted, "anthropic", "billing-model").ok).toBe(false);
  expect(hostedOperatorModelPolicy(hosted, "openai", "twice").ok).toBe(false);
  expect(hostedOperatorModelPolicy(hosted, "openai", "unlisted").ok).toBe(false);
  expect(hostedOperatorModelPolicy(hosted, "openai", "priced").ok).toBe(true);
  expect(
    hostedOperatorModelPolicy({ ...hosted, tenant_monthly_microunits: "0" }, "openai", "priced").ok,
  ).toBe(false);
  expect(hostedOperatorModelPolicy(undefined, "openai", "priced").ok).toBe(false);
});

test("invalid provider caps and malformed prices stay refused", () => {
  const config = configuration();
  const model = config.llm.hosted.models[0];
  if (!model) throw new Error("model fixture missing");
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
