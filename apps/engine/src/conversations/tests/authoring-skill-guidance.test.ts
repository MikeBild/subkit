import { beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { connectors, tenants } from "../../db/schema/index.ts";
import { countTokens } from "../../llm/accounting/index.ts";
import { LlmGenerationAborted } from "../../llm/errors.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { applySkillSeeds, loadEmbeddedSkillSeeds } from "../../skills/seed.ts";
import { runAuthoringPipeline } from "../authoring-pipeline.ts";
import {
  ctx,
  fetchCalls,
  makeCtx,
  tenant_id,
  tw,
  useAuthoringPipelineSetup,
} from "./authoring-pipeline-fixtures.ts";

useAuthoringPipelineSetup();

const SYSTEM_PROMPT_CEILING = 50_000;
let gmailConnectorId: string;

beforeAll(async () => {
  await applySkillSeeds(loadEmbeddedSkillSeeds().skills, tenant_id, ctx.db);
  await ctx.db
    .update(tenants)
    .set({ llm_primary: "issue-900-unrecognised-model" })
    .where(eq(tenants.id, tenant_id));
  const [gmail] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
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

const readOneMessage = () => ({
  name: "Read one Gmail message",
  slug: "read-one-gmail-message",
  input_schema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  steps: [
    {
      id: "message",
      kind: "request",
      connector_id: gmailConnectorId,
      method: "GET",
      path: "/users/me/messages/{{input.id}}",
    },
    {
      id: "summary",
      kind: "transform",
      language: "javascript",
      expression:
        "const message = input.scope.message.data; return { id: message.id, snippet: message.snippet };",
    },
  ],
});

const generateCalls = () => getMockProvider().calls.filter((call) => call.flow === "generate");

describe("authoring generation guidance with the real seed skills (#900)", () => {
  tw("a one-step read-only Gmail workflow fits the context and saves a draft", async () => {
    getMockProvider().generateOverrides.generate = readOneMessage;
    const toolCtx = makeCtx();
    const result = await runAuthoringPipeline({
      ctx: toolCtx,
      goal: "Read one Gmail message by id with GET /users/me/messages/{id} on the Gmail PROD connector and return its id and snippet.",
      connector_ids: ["gmail-prod"],
    });
    expect(result.ok).toBe(true);
    expect(toolCtx.getDraft().workflow).toMatchObject({ slug: "read-one-gmail-message" });
    const [call] = generateCalls();
    const system = call?.system ?? "";
    expect(countTokens(system)).toBeLessThan(SYSTEM_PROMPT_CEILING);
    expect(system).toContain("# Skill index for this generation");
    expect(system).toContain("`gmail-report-automation` — Gmail Report Automation");
    expect(system).toContain("# Gmail Report Automation");
    expect(system).toContain("`connector-creation-guidance`");
    expect(system).toContain("(load on demand)");
    expect(fetchCalls).toBe(0);
  });

  tw("a one-sentence goal without a connector fits the context", async () => {
    getMockProvider().generateOverrides.generate = () => ({
      name: "Greeting",
      slug: "greeting",
      steps: [
        {
          id: "greet",
          kind: "transform",
          language: "javascript",
          expression: "return { greeting: 'hello' };",
        },
      ],
    });
    const result = await runAuthoringPipeline({
      ctx: makeCtx(),
      goal: "Return a friendly greeting.",
    });
    expect(result.ok).toBe(true);
    const system = generateCalls()[0]?.system ?? "";
    expect(countTokens(system)).toBeLessThan(SYSTEM_PROMPT_CEILING);
    expect(system).not.toContain("# Gmail Report Automation");
  });

  tw(
    "generation loads a skill it asks for and regenerates with its complete guidance",
    async () => {
      let calls = 0;
      getMockProvider().generateOverrides.generate = () => {
        calls += 1;
        if (calls === 1) {
          throw new LlmGenerationAborted({
            reason: "the self-healing guidance is not included",
            needs: [
              {
                kind: "skill_guidance",
                connector_slug: null,
                method: null,
                path: null,
                question: null,
                skill_slug: "self-healing",
              },
            ],
          });
        }
        return readOneMessage();
      };
      const result = await runAuthoringPipeline({
        ctx: makeCtx(),
        goal: "Read one Gmail message by id and return its id and snippet.",
        connector_ids: ["gmail-prod"],
      });
      expect(result.ok).toBe(true);
      const [first, second] = generateCalls();
      expect(first?.system).not.toContain("# Self-Healing");
      expect(first?.system).toContain(
        "`self-healing` — Self-Healing And Patch Candidates [runtime] (load on demand)",
      );
      expect(second?.system).toContain(
        "`self-healing` — Self-Healing And Patch Candidates [runtime] (included below)",
      );
    },
  );
});
