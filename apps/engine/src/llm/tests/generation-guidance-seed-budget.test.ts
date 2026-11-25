import { afterAll, beforeAll, expect, test } from "bun:test";
import { connectors } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { applySkillSeeds, loadEmbeddedSkillSeeds } from "../../skills/seed.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { contextCapFor, countTokens } from "../accounting/index.ts";
import { formatSkill } from "../runtime/context-assembler/formatters.ts";
import { assembleEnhancedPrompt } from "../runtime/context-assembler.ts";

const UNRECOGNISED_MODEL = "issue-900-unrecognised-model";
const CAP = contextCapFor(UNRECOGNISED_MODEL);
const GUIDANCE_CEILING = Math.floor(CAP * 0.4);
const seeds = loadEmbeddedSkillSeeds().skills;

let fixture: TestDb;
let tenantId: string;
let gmailConnectorId: string;

beforeAll(async () => {
  fixture = await createTestDb("generation_guidance_seed_budget");
  const tenant = await seedTenant(fixture.db, {
    slug: "generation-seed-budget",
    display_name: "Generation seed budget",
  });
  tenantId = tenant.id;
  await applySkillSeeds(seeds, tenantId, fixture.db);
  const [gmail] = await fixture.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: "gmail-prod",
      display_name: "Gmail PROD",
      driver: "http",
      base_url: "https://gmail.googleapis.com/gmail/v1",
      auth_type: "none",
      template_slug: "google-gmail",
    })
    .returning();
  if (!gmail) throw new Error("gmail connector fixture missing");
  gmailConnectorId = gmail.id;
});

afterAll(async () => {
  await fixture?.cleanup();
});

const generate = (goal: string, connector_ids?: string[]) =>
  assembleEnhancedPrompt(
    {
      tenant_id: tenantId,
      flow: "generate",
      user_turns: [{ role: "user", content: goal }],
      retrieval_query: goal,
      model: UNRECOGNISED_MODEL,
      max_tokens: CAP,
      ...(connector_ids ? { connector_ids } : {}),
    },
    fixture.db,
  );

const guidanceTokens = (prompt: Awaited<ReturnType<typeof generate>>) =>
  prompt.included_skills.reduce((sum, skill) => sum + countTokens(formatSkill(skill)), 0);

test("unrecognised model ids keep the 100k fallback cap", () => {
  expect(CAP).toBe(100_000);
});

test("the complete seed catalog alone no longer fits the fallback cap", () => {
  const catalogTokens = seeds.reduce(
    (sum, seed) => sum + countTokens(`# ${seed.title}\n\n${seed.body}`),
    0,
  );
  expect(catalogTokens).toBeGreaterThan(GUIDANCE_CEILING);
});

test("a one-step read-only Gmail goal fits with guidance under 40% of the cap", async () => {
  const prompt = await generate(
    "Read one Gmail message by id with GET /users/me/messages/{id} on the Gmail PROD connector and return its subject, sender and snippet.",
    [gmailConnectorId],
  );
  expect(prompt.token_counts.total).toBeLessThanOrEqual(CAP);
  expect(guidanceTokens(prompt)).toBeLessThanOrEqual(GUIDANCE_CEILING);
  const included = prompt.included_skills.map((skill) => skill.slug);
  expect(included).toContain("gmail-report-automation");
  expect(included).toContain("http-connectors");
  expect(included).not.toContain("connector-creation-guidance");
  expect(included).not.toContain("github-graphql-basics");
  for (const seed of seeds) expect(prompt.system).toContain(`\`${seed.slug}\` — ${seed.title}`);
});

test("a one-sentence goal fits with guidance under 40% of the cap", async () => {
  const prompt = await generate("Summarise the newest support ticket every morning.");
  expect(prompt.token_counts.total).toBeLessThanOrEqual(CAP);
  expect(guidanceTokens(prompt)).toBeLessThanOrEqual(GUIDANCE_CEILING);
  const included = prompt.included_skills.map((skill) => skill.slug);
  expect(included).not.toContain("gmail-report-automation");
  expect(included).toContain("workflow-authoring-schedules");
});
