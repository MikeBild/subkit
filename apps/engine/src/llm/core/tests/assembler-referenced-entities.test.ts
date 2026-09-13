// The `[REFERENCED ENTITIES]` section (user @-mentions) in the assembler:
//  - rendered in the VOLATILE tail (never inside the cached prefix), as the
//    last section before the user turn;
//  - under budget pressure it shrinks to the one-line trim reference instead
//    of being dropped — the user pointed at these objects on purpose; only as
//    the very last resort before the base prompt cannot fit does the line go;
//  - its cost is reported in `token_counts.references`.
//
// Uses a real Postgres database via createTestDb (the assembler reads skills
// and the tenant snapshot); the block itself is passed in already rendered.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { logger } from "../../../logging/logger.ts";
import { resetMockProvider } from "../../mock-provider.ts";
import { assembleEnhancedPrompt } from "../context-assembler.ts";

const skip = process.env.REQUIRES_PG === "0";
if (skip) {
  logger.warn({
    module: "test",
    action: "test.suite.skipped",
    msg: "REQUIRES_PG=0 — skipping referenced-entities assembler verification.",
    suite: "assembler-referenced-entities",
  });
}

let ctx: TestDb;
let tenant_id: string;

const BLOCK = `[REFERENCED ENTITIES]
The user @-mentioned these objects in the next message. They are the authoritative targets — use the ids directly instead of searching by name.

WORKFLOW @customer-sync (id: 11111111-1111-4111-8111-111111111111)
\`\`\`json
${JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", slug: "customer-sync", steps: [] }, null, 2)}
\`\`\``;
const TRIM_REF = `[REFERENCED ENTITIES]
[trimmed to fit the context budget — the user @-mentioned these objects; use the ids directly, do not search by name]
- workflow @customer-sync (id: 11111111-1111-4111-8111-111111111111) — reload with inspect_workflow`;

beforeAll(async () => {
  if (skip) return;
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  ctx = await createTestDb("assembler_refs");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-asm-refs", display_name: "Assembler References" })
    .returning();
  tenant_id = t!.id;
}, 60_000);

afterAll(async () => {
  if (!skip && ctx) await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("assembler — referenced entities", () => {
  test("renders the block volatile, as the last system section, and counts it", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "run @customer-sync" }],
        max_tokens: 50_000,
        model: "mock",
        referenced_entities: { block: BLOCK, trim_ref: TRIM_REF },
      },
      ctx.db,
    );
    expect(prompt.system).toContain(BLOCK);
    expect(prompt.dropped_sections).not.toContain("referenced_entities");
    const sections = prompt.system_sections ?? [];
    const idx = sections.findIndex((s) => s.text === BLOCK);
    expect(idx).toBeGreaterThan(-1);
    expect(sections[idx]?.volatile).toBe(true);
    expect(idx).toBe(sections.length - 1);
    expect(prompt.token_counts.references).toBeGreaterThan(0);
  });

  test("without references the section is absent and costs nothing", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "hello" }],
        max_tokens: 50_000,
        model: "mock",
      },
      ctx.db,
    );
    expect(prompt.system).not.toContain("[REFERENCED ENTITIES]");
    expect(prompt.token_counts.references).toBe(0);
  });

  test("under budget pressure the block shrinks to the trim reference instead of vanishing", async () => {
    // A cap that fits the prompt with the one-line reference but not with
    // the full block: measure the trimmed shape first, then allow a hair
    // more than that.
    const trimmedShape = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "run @customer-sync" }],
        max_tokens: 50_000,
        model: "mock",
        referenced_entities: { block: TRIM_REF, trim_ref: TRIM_REF },
      },
      ctx.db,
    );
    const cap = trimmedShape.token_counts.total + 10;
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "converse",
        user_turns: [{ role: "user", content: "run @customer-sync" }],
        max_tokens: cap,
        model: "mock",
        referenced_entities: { block: BLOCK, trim_ref: TRIM_REF },
      },
      ctx.db,
    );
    expect(prompt.dropped_sections).toContain("referenced_entities");
    expect(prompt.system).toContain(TRIM_REF);
    expect(prompt.system).not.toContain(BLOCK);
    // The id survives the trim — that is the whole point of not dropping.
    expect(prompt.system).toContain("11111111-1111-4111-8111-111111111111");
    expect(prompt.token_counts.references).toBeGreaterThan(0);
    expect(prompt.token_counts.total).toBeLessThanOrEqual(cap);
  });
});
