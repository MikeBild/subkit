import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runExecution } from "../../execution/engine.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "../../execution/tests/setup.ts";
import { getBuiltinTemplate } from "../templates.ts";

const createContactWorkflow = () =>
  getBuiltinTemplate("hubspot")!.recipes.find((recipe) => recipe.slug === "create-contact")!
    .workflow;

let engineCtx: EngineTestCtx;
let hubspotReceiver: MockServer;
let receivedBodies: unknown[] = [];

beforeAll(async () => {
  engineCtx = await createEngineCtx("hubspot-create-contact");
  hubspotReceiver = await createMockServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    jsonResponse(res, 201, { id: "contact-1" });
  });
});

afterAll(async () => {
  await hubspotReceiver.close();
  await engineCtx.cleanup();
});

const runRecipe = async (input: Record<string, unknown>) => {
  receivedBodies = [];
  const workflowWithReceiver = JSON.parse(
    JSON.stringify(createContactWorkflow()).replaceAll(
      "${connector.hubspot.base_url}",
      hubspotReceiver.baseUrl,
    ),
  );
  const { workflow_id } = await createWorkflowRow(engineCtx, workflowWithReceiver);
  const result = await runExecution({
    db: engineCtx.testDb.db,
    tenant_id: engineCtx.tenantId,
    source: { kind: "saved", workflow_id },
    input,
  });
  return { result, body: receivedBodies[0] as { properties: Record<string, unknown> } };
};

describe("hubspot create-contact recipe (#580)", () => {
  test("omits optional properties that were not provided", async () => {
    const { result, body } = await runRecipe({ email: "zoe@example.com", firstname: "Zoë 東京" });
    expect(result.status).toBe("succeeded");
    expect(body.properties).toEqual({ email: "zoe@example.com", firstname: "Zoë 東京" });
    expect(JSON.stringify(body)).not.toContain("${");
  });

  test("sends every property when all are provided", async () => {
    const { result, body } = await runRecipe({
      email: "ada@example.com",
      firstname: "Ada",
      lastname: "Lovelace",
    });
    expect(result.status).toBe("succeeded");
    expect(body.properties).toEqual({
      email: "ada@example.com",
      firstname: "Ada",
      lastname: "Lovelace",
    });
  });

  test("no request body references an optional input field directly", () => {
    const workflow = createContactWorkflow() as unknown as {
      input_schema: { required: string[]; properties: Record<string, unknown> };
      steps: Array<{ kind: string; body?: unknown }>;
    };
    const optionalFields = Object.keys(workflow.input_schema.properties).filter(
      (field) => !workflow.input_schema.required.includes(field),
    );
    const requestBodies = JSON.stringify(
      workflow.steps.filter((step) => step.kind === "request").map((step) => step.body),
    );
    expect(optionalFields.filter((field) => requestBodies.includes(`\${input.${field}}`))).toEqual(
      [],
    );
  });
});
