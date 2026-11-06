import { afterAll, beforeAll, expect, test } from "bun:test";
import { skills } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { assembleEnhancedPrompt } from "../core/context-assembler.ts";

let fixture: TestDb;
let tenantId: string;
const requiredGuidance = `${"Preserve the reviewed execution boundary. ".repeat(200)}FINAL_REQUIRED_CALLER_CONTRACT`;

beforeAll(async () => {
  fixture = await createTestDb("generation_skill_guidance");
  const tenant = await seedTenant(fixture.db, {
    slug: "generation-guidance",
    display_name: "Generation guidance",
  });
  tenantId = tenant.id;
  await fixture.db.insert(skills).values([
    {
      tenant_id: tenantId,
      slug: "required-domain-contract",
      title: "Required domain contract",
      description: "Approved domain constraints",
      body: requiredGuidance,
      scope: "global",
      lifecycle: "active",
      applies_to: "authoring",
      source: "manual",
    },
    {
      tenant_id: tenantId,
      slug: "conversation-procedure",
      title: "Conversation procedure",
      description: "Interactive workflow procedure",
      body: "CHAT_ONLY_BODY_MUST_NOT_REACH_GENERATION",
      scope: "global",
      lifecycle: "active",
      applies_to: "chat",
      source: "manual",
    },
  ]);
});

afterAll(async () => {
  await fixture?.cleanup();
});

test("nested generation includes complete applicable guidance and no unavailable loading instruction", async () => {
  const prompt = await assembleEnhancedPrompt(
    {
      tenant_id: tenantId,
      flow: "generate",
      user_turns: [{ role: "user", content: "Generate one workflow definition." }],
      model: "mock",
      max_tokens: 13_000,
    },
    fixture.db,
  );
  expect(prompt.system).toContain(requiredGuidance);
  expect(prompt.system).not.toContain("CHAT_ONLY_BODY_MUST_NOT_REACH_GENERATION");
  expect(prompt.system).not.toContain("skill index — call");
  expect(prompt.system).toContain("use abort to name the exact missing fact");
  expect(prompt.token_counts.total).toBeLessThanOrEqual(13_000);
});

test("generation refuses a budget that cannot retain its approved domain contract", async () => {
  await expect(
    assembleEnhancedPrompt(
      {
        tenant_id: tenantId,
        flow: "generate",
        user_turns: [{ role: "user", content: "Generate one workflow definition." }],
        model: "mock",
        max_tokens: 500,
      },
      fixture.db,
    ),
  ).rejects.toThrow("generation cannot omit required guidance or call tools to reload it");
});
