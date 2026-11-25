import { afterAll, beforeAll, expect, test } from "bun:test";
import { connectors, skills } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { assembleEnhancedPrompt } from "../runtime/context-assembler.ts";

let fixture: TestDb;
let tenantId: string;
let gmailConnectorId: string;
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
    {
      tenant_id: tenantId,
      slug: "gmail-message-shape",
      title: "Gmail message shape",
      description: "Gmail connector guidance",
      body: "GMAIL_CONNECTOR_GUIDANCE_BODY",
      scope: "global",
      lifecycle: "active",
      audience: ["connector:google-gmail"],
      source: "manual",
    },
    {
      tenant_id: tenantId,
      slug: "operator-runbook",
      title: "Operator runbook",
      description: "Interactive operator guidance",
      body: "RUNTIME_ONLY_BODY_MUST_NOT_REACH_GENERATION",
      scope: "global",
      lifecycle: "active",
      audience: ["runtime"],
      source: "manual",
    },
  ]);
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

const generate = (p: { max_tokens: number; goal?: string; connector_ids?: string[] }) =>
  assembleEnhancedPrompt(
    {
      tenant_id: tenantId,
      flow: "generate",
      user_turns: [{ role: "user", content: p.goal ?? "Generate one workflow definition." }],
      model: "mock",
      max_tokens: p.max_tokens,
      ...(p.connector_ids ? { connector_ids: p.connector_ids } : {}),
    },
    fixture.db,
  );

test("a skill is included completely within budget and the index lists every applicable skill", async () => {
  const prompt = await generate({ max_tokens: 13_000 });
  expect(prompt.system).toContain(requiredGuidance);
  expect(prompt.system).toContain(
    "`required-domain-contract` — Required domain contract (included below)",
  );
  expect(prompt.system).toContain(
    "`operator-runbook` — Operator runbook [runtime] (load on demand)",
  );
  expect(prompt.system).not.toContain("CHAT_ONLY_BODY_MUST_NOT_REACH_GENERATION");
  expect(prompt.system).not.toContain("conversation-procedure");
  expect(prompt.system).not.toContain("skill index — call");
  expect(prompt.system).toContain("use abort to name the exact missing fact");
  expect(prompt.token_counts.total).toBeLessThanOrEqual(13_000);
});

test("a skill that does not fit the guidance budget is left out whole and stays loadable on demand", async () => {
  const prompt = await generate({ max_tokens: 2_000 });
  expect(prompt.system).not.toContain("Preserve the reviewed execution boundary.");
  expect(prompt.system).not.toContain("FINAL_REQUIRED_CALLER_CONTRACT");
  expect(prompt.system).toContain(
    "`required-domain-contract` — Required domain contract (load on demand)",
  );
  expect(prompt.system).toContain("a need of kind `skill_guidance`");
  expect(prompt.token_counts.total).toBeLessThanOrEqual(2_000);
});

test("generation fails only when the goal itself does not fit", async () => {
  await expect(
    generate({ max_tokens: 2_000, goal: "Read every message. ".repeat(600) }),
  ).rejects.toThrow("The generation goal does not fit the model context budget");
});

test("connector guidance is pre-included only when its connector is in scope", async () => {
  const withoutConnector = await generate({ max_tokens: 13_000 });
  expect(withoutConnector.system).not.toContain("GMAIL_CONNECTOR_GUIDANCE_BODY");
  expect(withoutConnector.system).toContain("`gmail-message-shape`");
  expect(withoutConnector.system).not.toContain("RUNTIME_ONLY_BODY_MUST_NOT_REACH_GENERATION");
  expect(withoutConnector.system).toContain(requiredGuidance);
  const withGmail = await generate({ max_tokens: 13_000, connector_ids: [gmailConnectorId] });
  expect(withGmail.system).toContain("GMAIL_CONNECTOR_GUIDANCE_BODY");
  expect(withGmail.system).not.toContain("RUNTIME_ONLY_BODY_MUST_NOT_REACH_GENERATION");
  expect(withGmail.system).toContain(requiredGuidance);
});

test("an interactive turn keeps offering runtime and connector guidance in its index", async () => {
  const prompt = await assembleEnhancedPrompt(
    {
      tenant_id: tenantId,
      flow: "converse",
      user_turns: [{ role: "user", content: "What can I do here?" }],
      model: "mock",
      max_tokens: 13_000,
    },
    fixture.db,
  );
  expect(prompt.system).toContain("operator-runbook");
  expect(prompt.system).toContain("gmail-message-shape");
});
