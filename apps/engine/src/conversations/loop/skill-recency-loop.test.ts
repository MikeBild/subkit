import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors, skills, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { assembleEnhancedPrompt } from "../../llm/runtime/context-assembler.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import {
  listBaselineSlugs,
  loadActivationCatalog,
  reaffirmLoadedForTurn,
} from "../skill-autoload.ts";
import { applyRecency, type LoadedSkillEntry, SKILL_FULL_BODY_RECENCY_K } from "./skill-recency.ts";

const skip = testEnv.REQUIRES_PG === "0";
const K = SKILL_FULL_BODY_RECENCY_K;

let db: TestDb;
let tenant_id: string;
let experimentalSlug: string;
let baselineSlug: string;

beforeAll(async () => {
  if (skip) return;
  db = await createTestDb("skill_recency_loop");

  const [t] = await db.db
    .insert(tenants)
    .values({ slug: "t-recency-loop", display_name: "Recency Loop Test" })
    .returning();
  tenant_id = t!.id;

  const [conn] = await db.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "oos-loop-connector",
      display_name: "OOS Loop Connector",
      driver: "http",
      environment: "dev",
      auth_type: "none",
    })
    .returning();

  const [exp, base] = await db.db
    .insert(skills)
    .values([
      {
        tenant_id,
        slug: "experimental-loadme",
        title: "Experimental Load-Me Skill",
        body: "EXPERIMENTAL_BODY_MARKER: only via load_skill; ages out to the index.",
        scope: "connector",
        connector_id: conn!.id,
        lifecycle: "active",
        source: "template",
        maturity: "experimental",
        activates_when: [],
      },
      {
        tenant_id,
        slug: "baseline-core",
        title: "Baseline Core Skill",
        body: "BASELINE_BODY_MARKER: core mental model, always full-body.",
        scope: "global",
        lifecycle: "active",
        source: "template",
        maturity: "stable",
        activates_when: [{ kind: "baseline" }],
      },
    ])
    .returning();
  experimentalSlug = exp!.slug!;
  baselineSlug = base!.slug!;
}, 60_000);

afterAll(async () => {
  if (!skip && db?.cleanup) await db.cleanup();
}, 30_000);

describe.skipIf(skip)("loop recency seam → assembler index-safety", () => {
  test("an out-of-scope experimental skill demotes after K idle turns but still renders in the Loaded index", async () => {
    const catalog = await loadActivationCatalog(tenant_id, db.db);
    const baselineSlugSet = new Set(listBaselineSlugs(catalog));
    expect(baselineSlugSet.has(baselineSlug)).toBe(true);

    let loaded: LoadedSkillEntry[] = [
      { slug: experimentalSlug, last_turn: 1 },
      { slug: baselineSlug, last_turn: 1 },
    ];

    let lastRecency = applyRecency(loaded, 1, new Set([baselineSlug]), [], baselineSlugSet);
    for (let turn = 2; turn <= 1 + K; turn += 1) {
      const loadedSlugs = loaded.map((e) => e.slug);
      const reaffirmed = reaffirmLoadedForTurn(
        {
          mode: "user_turn",
          user_text: "yes",
          connector_drivers: [],
          connector_templates: [],
        },
        catalog,
        loadedSlugs,
      );
      const refresh = new Set<string>([
        ...loadedSlugs.filter((s) => baselineSlugSet.has(s)),
        ...reaffirmed,
      ]);
      lastRecency = applyRecency(loaded, turn, refresh, [], baselineSlugSet);
      loaded = lastRecency.next;
    }

    expect(lastRecency.fullBodySet).not.toContain(experimentalSlug);
    expect(lastRecency.membership).toContain(experimentalSlug);
    expect(lastRecency.fullBodySet).toContain(baselineSlug);

    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "yes" }],
        max_tokens: 40_000,
        model: "mock",
        loaded_skill_slugs: lastRecency.fullBodySet,
        loaded_skill_membership: lastRecency.membership,
      },
      db.db,
    );

    expect(prompt.system).not.toContain("# Skill: Experimental Load-Me Skill");
    expect(prompt.system).toContain("Loaded skill index");
    expect(prompt.system).toContain(experimentalSlug);
    expect(prompt.system).toContain("Experimental Load-Me Skill");
  });
});
