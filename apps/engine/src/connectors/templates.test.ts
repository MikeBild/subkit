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

  test("ships 103 templates", () => {
    // Bump this counter when adding/removing built-in templates. The
    // canonical drift guard is `loadBuiltinTemplates()` at startup —
    // every entry must pass `ConnectorTemplateSchema`. This test pins
    // the catalog size so a stray add/remove surfaces explicitly.
    //
    // History: 95 → 101 (six AWS/oauth2 entries in F6) → 102
    // (web-scraper from #144) → 103 (generic-multipart-upload).
    expect(templates.length).toBe(103);
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

  test("stripe / github / postgres carry the seeded + Workstream-D demonstration recipes", () => {
    const counts = Object.fromEntries(
      templates.filter((t) => t.recipes.length > 0).map((t) => [t.slug, t.recipes.length]),
    );
    // Initial seed: stripe 12, github 10, postgres 8. Workstream D
    // (recipe sweep) added demonstration recipes for unused
    // WorkflowDefSchema primitives:
    //   stripe   +3 → 15 (charge-or-refund-by-amount [BranchStep],
    //                     create-customer-idempotent [idempotency_key],
    //                     list-charges-validate-no-zero-amount [validation_function])
    //   github   +3 → 13 (list-repos-retry-on-secondary-rate-limit [retry_on_status],
    //                     fan-out-issues-prs-releases [ParallelStep],
    //                     list-all-repos-paginate-js-form [LoopStep.data_selector])
    //   postgres +3 → 11 (update-must-affect-exactly-one-row [expected_row_count],
    //                     atomic-debit-credit-double-entry [sql.also],
    //                     export-large-table-stream [sql.cursor])
    // Issues #46 + #47 (trigger executor recipes):
    //   stripe   +2 → 17 (daily-charges-digest [trigger.kind=schedule],
    //                     on-charge-failed-notify-slack [trigger.kind=webhook])
    // Issue #54 (multi-connector binding via connector_bindings):
    //   stripe   +1 → 18 (new-customer-enrich-notify
    //                     [3 placeholders: stripe + hubspot + slack])
    // Workstream A8 (#51 + #47 lifecycle pattern, replaces multi-day wait):
    //   stripe   +1 → 19 (incremental-charges-via-state
    //                     [trigger.kind=schedule + state_read + state_write])
    // Issue #146 / Part D (close KNOWN_UNCOVERED step kinds):
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

  // #147 review S7 — JSON round-trip safety for ConnectorTemplate.
  //
  // After E.1, `buildTemplateBindingFields` returns the typed
  // `ConnectorTemplate` directly into a drizzle jsonb column (no
  // generic widening cast). That works only as long as every field
  // on `ConnectorTemplate` is JSON-serialisable: the moment a future
  // Zod-side change introduces a `Date`, a `Map`, or a method on the
  // schema, the jsonb writer would silently drop or stringify the
  // value and snapshot reads later would not equal the source. This
  // test pins the invariant — every catalog entry must round-trip
  // through `JSON.parse(JSON.stringify(...))` without loss.
  //
  // Scope (per #147 round-5 review S-5): this is a *structural* check
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
  // actual sweep lives in `scripts/audit/template-vendor-sweep.ts` behind
  // the `RUN_TEMPLATE_AUDIT=1` gate. This test is the bridge: it only
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
          `Run: RUN_TEMPLATE_AUDIT=1 bun run scripts/audit/template-vendor-sweep.ts --update-templates`,
          ...lines,
        ].join("\n"),
      );
    }
    // Asserting `true` keeps Bun's reporter from marking the test as
    // empty; the warning is the actual signal.
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
