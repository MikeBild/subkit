import { describe, expect, test } from "bun:test";
import { loadBuiltinTemplates, ProbeEndpointSchema } from "./templates.ts";

const templates = loadBuiltinTemplates();

describe("connector-template catalog — structural", () => {
  test("loads without throwing (every entry passes ConnectorTemplateSchema)", () => {
    expect(templates.length).toBeGreaterThanOrEqual(10);
  });

  test("ships the expected number of templates", () => {
    expect(templates.length).toBe(62);
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

  test("GitHub GraphQL guides private Project reads without requesting write scope by default", () => {
    const template = templates.find((entry) => entry.slug === "github-graphql");
    expect(template?.setup_instructions).toContain("read:project");
    expect(template?.setup_instructions).toContain(
      "fine-grained PATs cannot access user-owned Projects",
    );
    expect(template?.setup_instructions).toContain(
      "separate fine-grained repository-read connector",
    );
    expect(template?.setup_instructions).toContain("pageInfo.endCursor");
    expect(template?.setup_instructions).toContain("Mark the result incomplete");
    expect(template?.setup_instructions).toContain("REST OpenAPI discovery is not required");
    expect(template?.oauth?.scopes).not.toContain("project");
    expect(
      template?.auth_options?.find((option) => option.auth_type === "bearer")?.description,
    ).toContain("read:project");
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

  test("no recipe transform expression fails validateWorkflowDef (draft-save gate, #516)", async () => {
    const { validateWorkflowDef } = await import("../workflows/core/validator.ts");
    const failures = templates.flatMap((t) =>
      t.recipes.flatMap((r) =>
        validateWorkflowDef(r.workflow)
          .errors.filter((error) => error.path.endsWith(".expression"))
          .map((error) => `${t.slug}.${r.slug} ${error.path}: ${error.message}`),
      ),
    );
    expect(failures).toEqual([]);
  });

  test("every javascript recipe transform parses as a function body (#516)", () => {
    const failures = templates.flatMap((t) =>
      t.recipes.flatMap((r) =>
        (
          r.workflow.steps as Array<{
            id: string;
            kind: string;
            language?: string;
            expression?: string;
          }>
        )
          .filter(
            (step) => step.kind === "transform" && (step.language ?? "javascript") === "javascript",
          )
          .flatMap((step) => {
            try {
              new Function("input", step.expression ?? "");
              return [];
            } catch (error) {
              return [`${t.slug}.${r.slug}.${step.id}: ${(error as Error).message}`];
            }
          }),
      ),
    );
    expect(failures).toEqual([]);
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
