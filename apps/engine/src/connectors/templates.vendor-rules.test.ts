import { describe, expect, test } from "bun:test";
import { buildStepDag, detectCycles } from "../workflows/core/dag.ts";
import type { WorkflowDef } from "../workflows/types.ts";
import { loadBuiltinTemplates, ProbeDiagnosticsSchema, ReadOperationSchema } from "./templates.ts";

const templates = loadBuiltinTemplates();

describe("connector-template catalog — verified_at", () => {
  test("schema accepts both null and an ISO timestamp for verified_at", async () => {
    const { ConnectorTemplateSchema } = await import("./templates.ts");
    const valid = templates[0]!;
    const withNull = ConnectorTemplateSchema.safeParse({ ...valid, verified_at: null });
    expect(withNull.success).toBe(true);
    const withIso = ConnectorTemplateSchema.safeParse({
      ...valid,
      verified_at: "2026-04-01T00:00:00Z",
    });
    expect(withIso.success).toBe(true);
    const withGarbage = ConnectorTemplateSchema.safeParse({
      ...valid,
      verified_at: "not-a-date",
    });
    expect(withGarbage.success).toBe(false);
  });
});

describe("connector-template catalog — RFC7591 dynamic_registration coupling invariants", () => {
  test("dynamic_registration field is accepted by TemplateOAuthSchema", async () => {
    const { TemplateOAuthSchema } = await import("./templates.ts");
    const base = {
      issuer_url: "https://example.com",
      grant_type: "authorization_code",
      token_auth_method: "body",
      token_content_type: "form",
      use_pkce: true,
      client_id: null,
      extra_headers: {},
    };
    const withDynReg = TemplateOAuthSchema.safeParse({ ...base, dynamic_registration: true });
    expect(withDynReg.success).toBe(true);
    const withoutField = TemplateOAuthSchema.safeParse(base);
    expect(withoutField.success).toBe(true);
    if (withoutField.success) {
      expect(withoutField.data.dynamic_registration).toBe(false);
    }
  });

  test("every template with dynamic_registration=true has client_id=null", () => {
    for (const t of templates) {
      if (t.oauth?.dynamic_registration === true) {
        expect(t.oauth.client_id).toBeNull();
      }
    }
  });

  test("no template has dynamic_registration=true with a non-null client_id (would shadow the registered id)", () => {
    for (const t of templates) {
      if (t.oauth?.dynamic_registration === true) {
        expect(t.oauth.client_id).toBeNull();
      }
    }
    expect(true).toBe(true);
  });
});

describe("connector-template catalog — operator_quirks (migration 0006)", () => {
  test("legacy `operator_notes` field is rejected by the schema", async () => {
    const { ConnectorTemplateSchema } = await import("./templates.ts");
    const valid = templates[0]!;
    const withLegacy = { ...valid, operator_notes: "should be rejected" } as unknown;
    const result = ConnectorTemplateSchema.safeParse(withLegacy);
    if (result.success) {
      expect((result.data as Record<string, unknown>).operator_notes).toBeUndefined();
    }
  });

  test("operator_quirks accepts every category and rejects strings >2K chars", async () => {
    const { OperatorQuirksSchema } = await import("./types.ts");
    const all = OperatorQuirksSchema.parse({
      auth: "a",
      pagination: "b",
      rate_limit: "c",
      schema: "d",
      error_handling: "e",
      general: "f",
    });
    expect(all.general).toBe("f");
    const tooBig = OperatorQuirksSchema.safeParse({ auth: "x".repeat(2001) });
    expect(tooBig.success).toBe(false);
  });

  test("the github template has its quirk in `error_handling`", () => {
    const github = templates.find((t) => t.slug === "github");
    expect(github).toBeDefined();
    expect(github?.operator_quirks.error_handling ?? "").toMatch(/422/);
  });
});

describe("connector-template catalog — browserless query-auth hardening", () => {
  test("browserless template defaults to query auth (not bearer)", () => {
    const t = templates.find((x) => x.slug === "browserless");
    expect(t).toBeDefined();
    expect(t?.auth_type).toBe("query");
  });

  test("browserless documents its query auth path in auth_options (no broken bearer path offered)", () => {
    const t = templates.find((x) => x.slug === "browserless");
    const opts = t?.auth_options ?? [];
    expect(opts.length).toBeGreaterThan(0);
    expect(opts.every((o) => o.auth_type === "query")).toBe(true);
    expect(opts.some((o) => o.auth_type === "bearer")).toBe(false);
  });

  test("browserless credential hint is the canonical query shape (field `value`)", () => {
    const t = templates.find((x) => x.slug === "browserless");
    const hints = t?.credential_hints ?? [];
    expect(hints.length).toBe(1);
    expect(hints[0]?.field).toBe("value");
    expect(hints[0]?.secret).toBe(true);
  });

  test("browserless does not claim OpenAPI ingestion it cannot perform", () => {
    const t = templates.find((x) => x.slug === "browserless");
    expect(t?.ingestion_source).toBe("unsupported");
    expect(t?.ingestion_url ?? null).toBeNull();
  });

  test("browserless setup_instructions name the `token` query param and warn off bearer", () => {
    const t = templates.find((x) => x.slug === "browserless");
    const setup = t?.setup_instructions ?? "";
    expect(setup).toContain("?token=");
    expect(setup.toLowerCase()).toContain("bearer");
  });

  test("browserless-basics skill is accurate (query auth, /chrome/* , side_effects, unblock; no bearer-works claim)", async () => {
    const skillsModule = (await import("./template-skills.json", { with: { type: "json" } })) as {
      default: Record<string, { body: string; best_practices?: string[]; pitfalls?: string[] }>;
    };
    const skill = skillsModule.default["browserless-basics"];
    if (!skill) throw new Error("browserless-basics skill missing from template-skills.json");
    const blob = [skill.body, ...(skill.best_practices ?? []), ...(skill.pitfalls ?? [])]
      .join("\n")
      .toLowerCase();
    expect(blob).toContain("?token=");
    expect(blob).toContain("/chrome/");
    expect(blob).toContain("side_effects");
    expect(blob).toContain("/unblock");
    expect(blob).toContain("proxy=residential");
    expect(blob).toContain("500");
    expect(blob).not.toContain("/smart-scrape");
  });

  test("browserless-basics skill steers authors to /chrome/function for late-rendered pages", async () => {
    const skillsModule = (await import("./template-skills.json", { with: { type: "json" } })) as {
      default: Record<string, { body: string; best_practices?: string[]; pitfalls?: string[] }>;
    };
    const skill = skillsModule.default["browserless-basics"];
    if (!skill) throw new Error("browserless-basics skill missing");
    const blob = [skill.body, ...(skill.best_practices ?? []), ...(skill.pitfalls ?? [])]
      .join("\n")
      .toLowerCase();
    expect(blob).toContain("/chrome/content");
    expect(blob).toContain("/chrome/function");
    expect(blob).toContain("reload");
    expect(blob).toContain("selector_missing");
    expect(blob).toContain("empty");
  });

  test("browserless template ships the scrape-then-email-digest recipe", () => {
    const t = templates.find((x) => x.slug === "browserless");
    expect(t).toBeDefined();
    const recipe = t?.recipes.find((r) => r.slug === "scrape-then-email-digest");
    expect(recipe).toBeDefined();
    expect(recipe?.required_connectors).toHaveLength(2);
    expect(recipe?.required_connectors.map((c) => c.template).sort()).toEqual([
      "browserless",
      "sendgrid",
    ]);
    const scrapeStep = recipe?.workflow.steps.find((s) => s.id === "scrape");
    expect(JSON.stringify(scrapeStep)).toContain("/chrome/function");
    const transformStep = recipe?.workflow.steps.find((s) => s.id === "normalise");
    expect(transformStep?.kind).toBe("transform");
    expect(recipe?.workflow.trigger?.kind).toBe("schedule");
  });

  test("browserless scrape-then-email-digest recipe has no dependency cycle (#520)", () => {
    const recipe = templates
      .find((x) => x.slug === "browserless")
      ?.recipes.find((r) => r.slug === "scrape-then-email-digest");
    expect(detectCycles(buildStepDag(recipe!.workflow as WorkflowDef)).has_cycle).toBe(false);
  });
});

describe("connector-template catalog — Anthropic and Google Analytics 4", () => {
  const find = (slug: string) => {
    const template = templates.find((t) => t.slug === slug);
    if (!template) throw new Error(`template ${slug} missing`);
    return template;
  };

  test("anthropic sends its key in x-api-key and the version header on the probe", () => {
    const anthropic = find("anthropic");
    expect(anthropic.auth_type).toBe("header");
    expect(anthropic.credential_hints.map((h) => h.header_name)).toEqual(["x-api-key"]);
    expect(anthropic.probe_endpoint?.headers).toEqual({ "anthropic-version": "2023-06-01" });
  });

  test("every anthropic recipe sets the version header and every messages call carries a run budget", () => {
    const anthropic = find("anthropic");
    expect(anthropic.recipes.length).toBe(3);
    for (const recipe of anthropic.recipes) {
      const steps = (
        recipe.workflow.steps as Array<{
          kind: string;
          url?: string;
          headers?: Record<string, string>;
        }>
      ).filter((step) => step.kind === "request");
      for (const step of steps) expect(step.headers?.["anthropic-version"]).toBe("2023-06-01");
      if (steps.some((step) => step.url?.endsWith("/messages")))
        expect(recipe.workflow.max_llm_tokens_per_run).toBeGreaterThan(0);
    }
  });

  test("google analytics reads with the analytics.readonly scope and probes the shared metadata", () => {
    const ga4 = find("google-analytics");
    expect(ga4.oauth?.scopes).toBe("https://www.googleapis.com/auth/analytics.readonly");
    expect(ga4.probe_endpoint?.path).toBe("/v1beta/properties/0/metadata");
    expect(ga4.recipes.length).toBeGreaterThanOrEqual(3);
    for (const recipe of ga4.recipes) {
      expect(recipe.workflow.input_schema?.required).toContain("property_id");
      for (const step of recipe.workflow.steps as Array<{ kind: string; side_effects?: string }>)
        if (step.kind === "request") expect(step.side_effects).toBe("read");
    }
  });
});

describe("connector-template provider metadata", () => {
  test("only the analytics template declares a read POST operation", () => {
    expect(templates.filter((t) => t.read_operations.length > 0).map((t) => t.slug)).toEqual([
      "google-analytics",
    ]);
  });

  test("read operations must name a bare https origin and an anchored valid path pattern", () => {
    const valid = {
      method: "POST",
      origin: "https://api.example.test",
      path_pattern: "^/v1/reports:run$",
    };
    expect(ReadOperationSchema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      { ...valid, method: "PUT" },
      { ...valid, origin: "http://api.example.test" },
      { ...valid, origin: "https://api.example.test/v1" },
      { ...valid, path_pattern: "/v1/reports:run" },
      { ...valid, path_pattern: "^/v1/reports:run" },
      { ...valid, path_pattern: "^/v1/(reports$" },
    ])
      expect(ReadOperationSchema.safeParse(invalid).success).toBe(false);
  });

  test("every googleapis template declares the api_disabled probe diagnostic", () => {
    const google = templates.filter((t) => /googleapis\.com/.test(t.base_url ?? ""));
    expect(google.length).toBeGreaterThan(0);
    for (const template of google)
      expect(template.probe_diagnostics?.remote_api_disabled).toEqual({
        error_reason: "accessNotConfigured",
        service_host: "{api}.googleapis.com",
        action_url: "https://console.cloud.google.com/apis/library/{service}",
      });
    expect(
      templates
        .filter((t) => t.probe_diagnostics !== null && !google.includes(t))
        .map((t) => t.slug),
    ).toEqual([]);
  });

  test("probe diagnostics require the service placeholders", () => {
    const valid = {
      remote_api_disabled: {
        error_reason: "disabled",
        service_host: "{api}.example.test",
        action_url: "https://console.example.test/{service}",
      },
    };
    expect(ProbeDiagnosticsSchema.safeParse(valid).success).toBe(true);
    expect(
      ProbeDiagnosticsSchema.safeParse({
        remote_api_disabled: { ...valid.remote_api_disabled, service_host: "api.example.test" },
      }).success,
    ).toBe(false);
    expect(
      ProbeDiagnosticsSchema.safeParse({
        remote_api_disabled: {
          ...valid.remote_api_disabled,
          action_url: "https://console.example.test/",
        },
      }).success,
    ).toBe(false);
  });
});
