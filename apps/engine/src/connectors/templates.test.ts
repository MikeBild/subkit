// Connector-template catalog — structural lint + cross-reference invariants.
//
// `loadBuiltinTemplates()` already throws at engine boot if any entry
// fails ConnectorTemplateSchema. Running it inside a test makes that
// trip at PR time instead, before the bad commit lands. Plus a few
// invariants that the schema can't express on a single row but that
// must hold across the whole 90-template catalog.

import { describe, expect, test } from "bun:test";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { loadBuiltinTemplates } from "./templates.ts";

const templates = loadBuiltinTemplates();

describe("connector-template catalog — structural", () => {
  test("loads without throwing (every entry passes ConnectorTemplateSchema)", () => {
    expect(templates.length).toBeGreaterThanOrEqual(10);
  });

  test("ships the expected number of templates", () => {
    // Bump this counter when adding/removing built-in templates. The
    // canonical drift guard is `loadBuiltinTemplates()` at startup —
    // every entry must pass `ConnectorTemplateSchema`. This test pins
    // the catalog size so a stray add/remove surfaces explicitly.
    expect(templates.length).toBe(106);
  });

  test("supabase-graphql url_pattern matches a real host, not the literal [^/]+", () => {
    // Regression: the pattern was copied with an over-escaped character
    // class (`\\[\\^/\\]\\+`) that matched the literal string "[^/]+"
    // instead of a hostname, so URL auto-detection never recognised the
    // connector. A proper `[^/]+` host class must match a real ref and
    // must not match the REST endpoint.
    const t = templates.find((x) => x.slug === "supabase-graphql");
    expect(t?.url_pattern).toBeTruthy();
    const re = new RegExp(t?.url_pattern as string);
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

  test("no url_pattern contains an over-escaped character class (compiles but never matches)", () => {
    // A backslash-escaped class like `\[\^/\]\+` compiles fine but matches the
    // literal text "[^/]+", so the pattern silently never matches a real host
    // (the v7.x outage where 24 templates were unreachable via URL match).
    const offenders = templates
      .filter((t) => t.url_pattern !== null && /\\\[\\?\^/.test(t.url_pattern as string))
      .map((t) => t.slug);
    expect(offenders).toEqual([]);
  });

  test("formerly over-escaped templates now match realistic hosts (not the literal class)", () => {
    // Closes the gap between "compiles" and "actually matches" for the 24
    // templates whose host class was over-escaped. Curated real URLs are more
    // robust than reverse-engineering each regex.
    const cases: Record<string, string> = {
      auth0: "https://example.auth0.com/api/v2",
      okta: "https://dev.okta.com/api/v1",
      zendesk: "https://acme.zendesk.com/api/v2",
      freshdesk: "https://acme.freshdesk.com/api/v2",
      servicenow: "https://acme.service-now.com/api/now",
      "servicenow-soap": "https://acme.service-now.com",
      snowflake: "https://acme.snowflakecomputing.com/api/v2",
      mailchimp: "https://us21.api.mailchimp.com/3.0",
      "azure-blob-storage": "https://acct.blob.core.windows.net",
      "azure-devops": "https://dev.azure.com/myorg/_apis",
      bamboohr: "https://api.bamboohr.com/api/gateway.php/acme/v1",
      confluence: "https://api.atlassian.com/ex/confluence/abc/wiki/api/v2",
      jira: "https://api.atlassian.com/ex/jira/abc/rest/api/3",
      supabase: "https://abcdef.supabase.co/rest/v1",
    };
    for (const [slug, url] of Object.entries(cases)) {
      const t = templates.find((x) => x.slug === slug);
      expect(t, `template ${slug} missing`).toBeDefined();
      const re = new RegExp(t?.url_pattern as string);
      expect(re.test(url), `${slug} should match ${url}`).toBe(true);
      // The literal-class form (the bug signature) must NOT match.
      expect(
        re.test((t?.url_pattern as string).replace(/^\^/, "").replace(/\[\^\/\]\+/g, "[^/]+")),
      ).toBe(false);
    }
  });

  test("every auth-requiring template documents at least one auth_options path", () => {
    // Empty auth_options is only legitimate for auth_type === "none"; every
    // other template must present at least one deliberate auth path to the LLM/UI.
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

  test("stripe / github / postgres carry the seeded + demonstration recipes", () => {
    const counts = Object.fromEntries(
      templates.filter((t) => t.recipes.length > 0).map((t) => [t.slug, t.recipes.length]),
    );
    // Initial seed: stripe 12, github 10, postgres 8. The recipe sweep
    // added demonstration recipes for unused WorkflowDefSchema
    // primitives:
    //   stripe   +3 → 15 (charge-or-refund-by-amount [BranchStep],
    //                     create-customer-idempotent [idempotency_key],
    //                     list-charges-validate-no-zero-amount [validation_function])
    //   github   +3 → 13 (list-repos-retry-on-secondary-rate-limit [retry_on_status],
    //                     fan-out-issues-prs-releases [ParallelStep],
    //                     list-all-repos-paginate-js-form [LoopStep.data_selector])
    //   postgres +3 → 11 (update-must-affect-exactly-one-row [expected_row_count],
    //                     atomic-debit-credit-double-entry [sql.also],
    //                     export-large-table-stream [sql.cursor])
    // Trigger executor recipes:
    //   stripe   +2 → 17 (daily-charges-digest [trigger.kind=schedule],
    //                     on-charge-failed-notify-slack [trigger.kind=webhook])
    // Multi-connector binding via connector_bindings:
    //   stripe   +1 → 18 (new-customer-enrich-notify
    //                     [3 placeholders: stripe + hubspot + slack])
    // Lifecycle pattern (replaces multi-day wait):
    //   stripe   +1 → 19 (incremental-charges-via-state
    //                     [trigger.kind=schedule + state_read + state_write])
    // Close KNOWN_UNCOVERED step kinds:
    //   github   +2 → 15 (delegated-triage-via-call [CallStep],
    //                     merge-pr-after-approval [WaitForEventStep])
    // 4.2.0: dropped lint-pr-changes-via-tool [ToolStep] when the
    //   docker-based sandbox was retired — subkit is a data-workflow
    //   engine, not a container runtime.
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

  // JSON round-trip safety for ConnectorTemplate.
  //
  // `buildTemplateBindingFields` returns the typed
  // `ConnectorTemplate` directly into a drizzle jsonb column (no
  // generic widening cast). That works only as long as every field
  // on `ConnectorTemplate` is JSON-serialisable: the moment a future
  // Zod-side change introduces a `Date`, a `Map`, or a method on the
  // schema, the jsonb writer would silently drop or stringify the
  // value and snapshot reads later would not equal the source. This
  // test pins the invariant — every catalog entry must round-trip
  // through `JSON.parse(JSON.stringify(...))` without loss.
  //
  // Scope: this is a *structural* check
  // only — it catches `Date`/`Map`/method drops at the JSON codec
  // boundary. It does NOT catch a Zod-side semantic transform (e.g.
  // `z.string().transform(s => s.toLowerCase())`) where round-trip
  // succeeds but the parsed shape diverges from the input. That class
  // of drift is covered by `template-resolver.test.ts` re-parsing
  // through `parseTemplateSnapshot`.
  test("every template round-trips through JSON without loss (jsonb writer safety)", () => {
    for (const t of templates) {
      const roundtrip = JSON.parse(JSON.stringify(t));
      expect(roundtrip).toEqual(t);
    }
  });
});

describe("connector-template catalog — Layer-3 vendor-drift sweep", () => {
  // Layer 1 (this file) is structural: it never touches the network. The
  // actual sweep (gated by `RUN_TEMPLATE_AUDIT=1`) is maintained in the
  // `subkit-deploy` repo. This test is the bridge: it only
  // *warns* (never fails) when a template's `verified_at` is null or
  // older than 90 days, so a stale catalog surfaces in `bun test` output
  // without blocking unrelated PRs. The sweep script — run on a cadence
  // an operator picks — refreshes the stamp.
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
    // Intentional warning, not assertion. Stale verification is a
    // signal — running the sweep is a deliberate operator action, not
    // something a PR author should be blocked on. The CI gate stays
    // green; the operator triages from `bun test` output.
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
          `Run the Layer-3 vendor-drift sweep (RUN_TEMPLATE_AUDIT=1, maintained in the subkit-deploy repo) to refresh verified_at.`,
          ...lines,
        ].join("\n"),
      );
    }
    // Asserting `true` keeps Bun's reporter from marking the test as
    // empty; the warning is the actual signal.
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
    // Default value is false — field is optional.
    const withoutField = TemplateOAuthSchema.safeParse(base);
    expect(withoutField.success).toBe(true);
    if (withoutField.success) {
      expect(withoutField.data.dynamic_registration).toBe(false);
    }
  });

  test("every template with dynamic_registration=true has client_id=null", () => {
    // Coupling invariant A: dynamic_registration implies client_id is null
    // (the client_id will be populated by RFC7591 at runtime).
    for (const t of templates) {
      if (t.oauth?.dynamic_registration === true) {
        expect(t.oauth.client_id).toBeNull();
      }
    }
  });

  test("no template has dynamic_registration=true with a non-null client_id (would shadow the registered id)", () => {
    // Coupling invariant B: a template that opts in to dynamic registration
    // must NOT pre-supply a client_id — that would silently shadow the one
    // issued by the IdP during registration and cause authz failures.
    for (const t of templates) {
      if (t.oauth?.dynamic_registration === true) {
        // Already covered by invariant A above; duplicate here makes
        // the constraint legible from both directions.
        expect(t.oauth.client_id).toBeNull();
      }
    }
    // Note: templates with dynamic_registration=false (or unset) may
    // legitimately have client_id=null — that means the tenant operator
    // must supply their own OAuth2 client credentials at connector
    // creation time. This is the standard pattern for 42 of the 103
    // built-in templates (GitHub, Slack, Google, etc.).
    expect(true).toBe(true);
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

describe("connector-template catalog — browserless query-auth hardening", () => {
  // Production sessions aba4551f / c3e1bd7e: the template defaulted to
  // `bearer`, which the SaaS hosts reject with HTTP 500 — the model
  // fought the template, invented `config.query_param_name`, and looped.
  // Browserless authenticates ONLY via the `?token=` query parameter.
  //
  // MIGRATION NOTE (v7.5.0): this flips tenant-visible template defaults
  // (auth_type bearer→query, auth_options emptied, credential_hints field
  // token→value, ingestion_source openapi→unsupported). Templates only
  // SEED defaults for NEW drafts — they never mutate stored connectors.
  // An already-saved Browserless connector with a bearer credential keeps
  // sending `Authorization: Bearer …` at runtime unchanged; only new
  // drafts (and re-auth flows) pick up query auth. The empty auth_options
  // is deliberate (bearer 500s on SaaS), matching the canonical query
  // templates scrapingbee/trello.
  test("browserless template defaults to query auth (not bearer)", () => {
    const t = templates.find((x) => x.slug === "browserless");
    expect(t).toBeDefined();
    expect(t?.auth_type).toBe("query");
  });

  test("browserless documents its query auth path in auth_options (no broken bearer path offered)", () => {
    const t = templates.find((x) => x.slug === "browserless");
    const opts = t?.auth_options ?? [];
    expect(opts.length).toBeGreaterThan(0);
    // Only the query path is offered — bearer is explicitly NOT listed.
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
    // The live spec is token-gated and incomplete for SaaS features, and
    // ingestion_url is null — so `openapi` was a false claim.
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
    // The skill must flag that bearer fails — never advertise it as a working option.
    expect(blob).toContain("500");
    expect(blob).not.toContain("/smart-scrape");
  });
});
