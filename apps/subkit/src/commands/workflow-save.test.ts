import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { EngineClient } from "../engine-client.ts";
import * as runtime from "./command-runtime.ts";
import { saveWorkflow } from "./workflow-save.ts";

afterEach(() => mock.restore());

test("recipe validation, preview and save use the same pinned install input (#519)", async () => {
  const definition = {
    name: "Analytics",
    steps: [
      {
        id: "report",
        kind: "request",
        path: `/v1beta/properties/\${input.property_id}:runReport`,
      },
    ],
  };
  const validate = mock(async (_body: unknown) => ({ ok: true }));
  const preview = mock(async (_body: unknown) => ({ status: "succeeded", execution_id: "ex-1" }));
  const create = mock(async (_body: unknown) => ({ id: "wf-1", name: "Analytics" }));
  spyOn(runtime, "makeClient").mockReturnValue({
    getRecipePack: async () => ({
      recipes: [
        {
          recipe_slug: "daily-analytics-report",
          connectors: [],
          install_inputs: ["property_id"],
          sample_input: { property_id: "sample" },
          workflow: definition,
        },
      ],
    }),
    validateWorkflowDraft: validate,
    runExecution: preview,
    createWorkflow: create,
  } as unknown as EngineClient);
  spyOn(process.stdout, "write").mockImplementation(() => true);
  spyOn(process.stderr, "write").mockImplementation(() => true);

  await saveWorkflow(
    { kind: "create" },
    {
      "from-recipe": "daily-analytics-report",
      input: JSON.stringify({ property_id: "123456789" }),
      json: true,
    },
  );

  const pinned = {
    ...definition,
    steps: [{ ...definition.steps[0], path: "/v1beta/properties/123456789:runReport" }],
    recipe: {
      vertical: "solutions",
      slug: "daily-analytics-report",
      inputs: { property_id: "123456789" },
    },
  };
  expect(validate).toHaveBeenCalledWith(pinned);
  expect(preview).toHaveBeenCalledWith(
    expect.objectContaining({ definition: pinned, input: { property_id: "123456789" } }),
    { environment: "dev" },
  );
  expect(create).toHaveBeenCalledWith(pinned);
  expect(definition.steps[0]?.path).toBe(`/v1beta/properties/\${input.property_id}:runReport`);
});
