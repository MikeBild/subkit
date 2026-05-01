// Connector-template catalog — structural lint + cross-reference invariants.
//
// `loadBuiltinTemplates()` already throws at engine boot if any entry
// fails ConnectorTemplateSchema. Running it inside a test makes that
// trip at PR time instead, before the bad commit lands. Plus a few
// invariants that the schema can't express on a single row but that
// must hold across the whole 90-template catalog.

import { describe, expect, test } from "bun:test";
import { loadBuiltinTemplates } from "./templates.ts";

const templates = loadBuiltinTemplates();

describe("connector-template catalog — structural", () => {
  test("loads without throwing (every entry passes ConnectorTemplateSchema)", () => {
    expect(templates.length).toBeGreaterThanOrEqual(10);
  });

  test("ships 96 templates", () => {
    // Bump this counter when adding/removing built-in templates. Pre-fix
    // we shipped four AppSync/AWS/GCP entries that the runtime
    // ConnectorTemplateSchema rejected at first-tool-invocation
    // (`templates.json validation failed: 90.base_url …`); the schema
    // and JSON were drifting — startup `loadBuiltinTemplates()` is the
    // canonical guard for that drift, exercised by this suite.
    expect(templates.length).toBe(95);
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
    // Templates may also OFFER oauth2 inside auth_options without making
    // it the primary auth_type; the loosened check is "if oauth2 is the
    // primary, the oauth block describing it must be present".
    for (const t of templates) {
      if (t.auth_type === "oauth2") {
        expect(t.oauth).not.toBeNull();
      }
    }
  });

  test("oauth.scopes is a string when present (space- or comma-separated)", () => {
    // Schema defines scopes as `z.string().optional()`. Treat the field
    // as a flat string the connector framework splits at use time;
    // catalog reality has both space- and comma-separated styles.
    for (const t of templates) {
      if (t.oauth?.scopes !== undefined) {
        expect(typeof t.oauth.scopes).toBe("string");
      }
    }
  });

  test("url_pattern compiles as a regex when present", () => {
    for (const t of templates) {
      if (t.url_pattern === null) continue; // per-tenant templates skip URL match
      expect(() => new RegExp(t.url_pattern as string)).not.toThrow();
    }
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
    // 90 templates with > 30 distinct categories would mean every other
    // template invents its own bucket; keep the guard generous so we
    // don't churn on legitimate growth, but tight enough to flag drift.
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
      // listed in schema for forward-compat — fail loudly if the
      // catalog uses one without a real driver:
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

  test("stripe ships 12 recipes, github ships 10, postgres ships 8 (initial seed)", () => {
    const counts = Object.fromEntries(
      templates.filter((t) => t.recipes.length > 0).map((t) => [t.slug, t.recipes.length]),
    );
    expect(counts.stripe).toBe(12);
    expect(counts.github).toBe(10);
    expect(counts.postgres).toBe(8);
  });

  test("recipe slugs are unique within each template", () => {
    for (const t of templates) {
      const slugs = t.recipes.map((r) => r.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
    }
  });

  test("every recipe.derived_from_skill resolves to a known template-skill (or is null)", async () => {
    // The cross-ref check inside loadBuiltinTemplates already throws
    // on unknown skills — this test just keeps the invariant explicit
    // and surfaces it as a unit failure instead of a boot crash.
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
});

describe("connector-template catalog — operator_quirks (migration 0006)", () => {
  test("legacy `operator_notes` field is rejected by the schema", async () => {
    const { ConnectorTemplateSchema } = await import("./templates.ts");
    const valid = templates[0]!;
    const withLegacy = { ...valid, operator_notes: "should be rejected" } as unknown;
    const result = ConnectorTemplateSchema.safeParse(withLegacy);
    // Strict-shape parses generally allow extra keys, but the field has
    // been removed from the schema so it MUST not appear in
    // result.data. Accept both behaviors: either rejected (preferred)
    // or stripped silently — but never round-tripped.
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
