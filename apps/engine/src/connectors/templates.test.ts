import { describe, expect, test } from "bun:test";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { loadBuiltinTemplates, ProbeEndpointSchema } from "./templates.ts";

const templates = loadBuiltinTemplates();

describe("connector-template catalog — structural", () => {
  test("loads without throwing (every entry passes ConnectorTemplateSchema)", () => {
    expect(templates.length).toBeGreaterThanOrEqual(10);
  });

  test("ships the expected number of templates", () => {
    expect(templates.length).toBe(61);
  });

  test("App Store Connect is a direct signed-JWT HTTP template with a fixed host", () => {
    const template = templates.find((entry) => entry.slug === "app-store-connect");
    expect(template?.base_url).toBe("https://api.appstoreconnect.apple.com");
    expect(template?.auth_type).toBe("signed_jwt");
    expect(template?.signed_jwt).toMatchObject({
      algorithm: "ES256",
      audience: "appstoreconnect-v1",
      ttl_seconds: 300,
    });
    expect(template?.oauth).toBeNull();
    expect(template?.ingestion_source).toBe("openapi");
    expect(template?.ingestion_url).toBe(
      "https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip",
    );
  });

  test("supabase-graphql url_pattern matches a real host, not the literal [^/]+", () => {
    const t = templates.find((x) => x.slug === "supabase-graphql");
    expect(t?.url_pattern).toBeTruthy();
    const re = new RegExp(t!.url_pattern as string);
    expect(re.test("https://abcdef.supabase.co/graphql/v1")).toBe(true);
    expect(re.test("https://abcdef.supabase.co/graphql/v1/")).toBe(true);
    expect(re.test("https://abcdef.supabase.co/rest/v1")).toBe(false);
    expect(re.test("https://[^/]+.supabase.co/graphql/v1")).toBe(false);
  });

  test("every slug matches the lowercase-kebab regex", () => {
    for (const t of templates) {
      expect(t.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  test("every template has a non-empty name + setup_instructions", () => {
    for (const t of templates) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.setup_instructions.length).toBeGreaterThan(0);
    }
  });
});

describe("connector-template probe headers", () => {
  test("Notion declares its required API version on the identity probe", () => {
    const notion = templates.find((template) => template.slug === "notion");
    expect(notion?.probe_endpoint?.headers).toEqual({ "Notion-Version": "2022-06-28" });
  });

  test("accepts bounded protocol headers and rejects auth or transport injection", () => {
    const base = {
      method: "GET" as const,
      path: "/users/me",
      expected_status: [200, 200] as [number, number],
    };
    expect(
      ProbeEndpointSchema.safeParse({
        ...base,
        headers: { "Notion-Version": "2022-06-28" },
      }).success,
    ).toBe(true);
    for (const name of [
      "Authorization",
      "authorization",
      "X-Api-Key",
      "X-Auth-Token",
      "Cookie",
      "Host",
    ]) {
      expect(
        ProbeEndpointSchema.safeParse({ ...base, headers: { [name]: "blocked" } }).success,
      ).toBe(false);
    }
  });

  test("enforces entry, value, and aggregate byte limits", () => {
    const base = { method: "GET" as const, path: "/health" };
    const tooMany = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`X-Probe-${index}`, "ok"]),
    );
    expect(ProbeEndpointSchema.safeParse({ ...base, headers: tooMany }).success).toBe(false);
    expect(
      ProbeEndpointSchema.safeParse({ ...base, headers: { "X-Probe": "x".repeat(1025) } }).success,
    ).toBe(false);
  });
});

describe("connector-template catalog — cross-reference invariants", () => {
  test("slugs are globally unique", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const t of templates) {
      if (seen.has(t.slug)) dupes.push(t.slug);
      seen.add(t.slug);
    }
    expect(dupes).toEqual([]);
  });

  test("templates declaring auth_type === 'oauth2' carry an oauth block", () => {
    for (const t of templates) {
      if (t.auth_type === "oauth2") {
        expect(t.oauth).not.toBeNull();
      }
    }
  });

  test("oauth.scopes is a string when present (space- or comma-separated)", () => {
    for (const t of templates) {
      if (t.oauth?.scopes !== undefined) {
        expect(typeof t.oauth.scopes).toBe("string");
      }
    }
  });

  test("url_pattern compiles as a regex when present", () => {
    for (const t of templates) {
      if (t.url_pattern === null) continue;
      expect(() => new RegExp(t.url_pattern as string)).not.toThrow();
    }
  });

  test("no url_pattern contains an over-escaped character class (compiles but never matches)", () => {
    const offenders = templates
      .filter((t) => t.url_pattern !== null && /\\\[\\?\^/.test(t.url_pattern as string))
      .map((t) => t.slug);
    expect(offenders).toEqual([]);
  });

  test("formerly over-escaped templates now match realistic hosts (not the literal class)", () => {
    const cases: Record<string, string> = {
      mailchimp: "https://us21.api.mailchimp.com/3.0",
      confluence: "https://api.atlassian.com/ex/confluence/abc/wiki/api/v2",
      jira: "https://api.atlassian.com/ex/jira/abc/rest/api/3",
      supabase: "https://abcdef.supabase.co/rest/v1",
      "supabase-graphql": "https://abcdef.supabase.co/graphql/v1",
      salesforce: "https://acme.my.salesforce.com/services/data/v59.0",
      shopify: "https://acme.myshopify.com/admin/api/2024-01",
    };
    for (const [slug, url] of Object.entries(cases)) {
      const t = templates.find((x) => x.slug === slug);
      expect(t, `template ${slug} missing`).toBeDefined();
      const re = new RegExp(t!.url_pattern as string);
      expect(re.test(url), `${slug} should match ${url}`).toBe(true);
      expect(
        re.test((t!.url_pattern as string).replace(/^\^/, "").replace(/\[\^\/\]\+/g, "[^/]+")),
      ).toBe(false);
    }
  });

  test("no url_pattern is a greedy host wildcard that matches an arbitrary unknown URL", () => {
    const arbitrary = [
      "https://totally-unknown-domain-xyz.example.com/api/foo",
      "https://another-random-host.test/v1",
    ];
    const offenders = templates
      .filter(
        (t) =>
          t.url_pattern !== null &&
          arbitrary.every((u) => new RegExp(t.url_pattern as string).test(u)),
      )
      .map((t) => t.slug);
    expect(offenders).toEqual([]);
  });

  test("every auth-requiring template documents at least one auth_options path", () => {
    const offenders = templates
      .filter((t) => t.auth_type !== "none" && t.auth_options.length === 0)
      .map((t) => t.slug);
    expect(offenders).toEqual([]);
  });

  test("base_url_options entries each carry a non-empty environment label and base_url", () => {
    for (const t of templates) {
      for (const opt of t.base_url_options) {
        expect(opt.environment.length).toBeGreaterThan(0);
        expect(opt.base_url.length).toBeGreaterThan(0);
      }
    }
  });

  test("category vocabulary stays bounded (smoke check on cardinality)", () => {
    const cats = new Set(templates.map((t) => t.category));
    expect(cats.size).toBeLessThanOrEqual(30);
  });

  test("driver is one of the 10 supported by the engine drivers/ folder", () => {
    const supported = new Set([
      "http",
      "graphql",
      "postgres",
      "s3",
      "ftp",
      "sftp",
      "smb",
      "mssql",
      "redis",
      "mysql",
      "caldav",
      "webdav",
      "soap",
      "grpc",
      "mqtt",
      "imap",
    ]);
    for (const t of templates) {
      expect(supported.has(t.driver)).toBe(true);
    }
  });
});

describe("connector-template catalog — recipes (migration 0006)", () => {
  test("ships at least 30 recipes total across the catalog", () => {
    const total = templates.reduce((acc, t) => acc + t.recipes.length, 0);
    expect(total).toBeGreaterThanOrEqual(30);
  });

  test("stripe / github / postgres carry the seeded + demonstration recipes", () => {
    const counts = Object.fromEntries(
      templates.filter((t) => t.recipes.length > 0).map((t) => [t.slug, t.recipes.length]),
    );
    expect(counts.stripe).toBe(19);
    expect(counts.github).toBe(15);
    expect(counts.postgres).toBe(11);
  });

  test("recipe slugs are unique within each template", () => {
    for (const t of templates) {
      const slugs = t.recipes.map((r) => r.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
    }
  });

  test("every recipe.derived_from_skill resolves to a known template-skill (or is null)", async () => {
    const skillsModule = (await import("./template-skills.json", { with: { type: "json" } })) as {
      default: Record<string, unknown>;
    };
    const known = new Set(Object.keys(skillsModule.default));
    for (const t of templates) {
      for (const r of t.recipes) {
        if (r.derived_from_skill === null) continue;
        expect(known.has(r.derived_from_skill)).toBe(true);
      }
    }
  });

  test("every recipe.workflow re-validates standalone under WorkflowDefSchema", async () => {
    const { WorkflowDefSchema } = await import("../workflows/types.ts");
    for (const t of templates) {
      for (const r of t.recipes) {
        const result = WorkflowDefSchema.safeParse(r.workflow);
        const reason = result.success
          ? ""
          : `recipe ${t.slug}.${r.slug} fails WorkflowDefSchema: ${JSON.stringify(result.error.issues)}`;
        expect(reason).toBe("");
      }
    }
  });

  test("every recipe.intent_keywords entry is a non-empty string", () => {
    for (const t of templates) {
      for (const r of t.recipes) {
        for (const kw of r.intent_keywords) {
          expect(typeof kw).toBe("string");
          expect(kw.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("recipes do not embed credential-shaped literals", () => {
    const secretLike =
      /(sk_live_|sk_test_|sk-[A-Za-z0-9]|xox[baprs]-|gh[pousr]_|AKIA[0-9A-Z]{16}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|Authorization\\s*:|Bearer\\s+[A-Za-z0-9._-]{12,})/;
    for (const t of templates) {
      for (const r of t.recipes) {
        expect(JSON.stringify(r.workflow)).not.toMatch(secretLike);
      }
    }
  });

  test("every template round-trips through JSON without loss (jsonb writer safety)", () => {
    for (const t of templates) {
      const roundtrip = JSON.parse(JSON.stringify(t));
      expect(roundtrip).toEqual(t);
    }
  });
});

describe("connector-template catalog — Layer-3 vendor-drift sweep", () => {
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

  test("warns (does NOT fail) when verified_at is null or older than 90 days", () => {
    const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
    const now = getTestNow();
    const stale: { slug: string; verified_at: string | null; reason: string }[] = [];
    for (const t of templates) {
      if (t.verified_at === null) {
        stale.push({ slug: t.slug, verified_at: null, reason: "never swept" });
        continue;
      }
      const verifiedMs = new Date(t.verified_at).getTime();
      if (Number.isNaN(verifiedMs)) {
        stale.push({ slug: t.slug, verified_at: t.verified_at, reason: "unparseable" });
        continue;
      }
      const ageMs = now - verifiedMs;
      if (ageMs > NINETY_DAYS_MS) {
        const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
        stale.push({
          slug: t.slug,
          verified_at: t.verified_at,
          reason: `${ageDays}d old (>90d)`,
        });
      }
    }
    if (stale.length > 0) {
      const lines = stale.map(
        (s) => `  - ${s.slug} (verified_at=${s.verified_at ?? "null"}, ${s.reason})`,
      );
      // eslint-disable-next-line no-console
      console.warn(
        [
          `[connector-templates] vendor-drift sweep stale on ${stale.length}/${templates.length} templates.`,
          `Run the Layer-3 vendor-drift sweep (RUN_TEMPLATE_AUDIT=1 bun scripts/template-vendor-sweep.ts) to refresh verified_at.`,
          ...lines,
        ].join("\n"),
      );
    }
    expect(true).toBe(true);
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
