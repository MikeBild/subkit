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

const scraperRecipe = () => ({
  slug: "fetch-page",
  title: "Fetch a page",
  install_inputs: ["site"],
  required_connectors: [],
  sample_input: { site: "docs" },
  workflow: {
    name: "fetch-page",
    steps: [{ id: "fetch", kind: "request", path: `/sites/\${input.site}/page` }],
  },
});

test("a template recipe is fetched by <template>/<recipe> and installed with its input (#895)", async () => {
  const recipeLookup = mock(async (_template: string, _recipe: string) => scraperRecipe());
  const create = mock(async (_body: unknown) => ({ id: "wf-2", name: "fetch-page" }));
  spyOn(runtime, "makeClient").mockReturnValue({
    getConnectorTemplateRecipe: recipeLookup,
    createWorkflow: create,
  } as unknown as EngineClient);
  spyOn(process.stdout, "write").mockImplementation(() => true);
  spyOn(process.stderr, "write").mockImplementation(() => true);

  await saveWorkflow(
    { kind: "create" },
    {
      "from-recipe": "web-scraper/fetch-page",
      input: JSON.stringify({ site: "handbook" }),
      "skip-checks": true,
      json: true,
    },
  );

  expect(recipeLookup).toHaveBeenCalledWith("web-scraper", "fetch-page");
  expect(create).toHaveBeenCalledWith({
    name: "fetch-page",
    steps: [{ id: "fetch", kind: "request", path: "/sites/handbook/page" }],
    recipe: { template: "web-scraper", slug: "fetch-page", inputs: { site: "handbook" } },
  });
});

test("a template recipe without its install input fails before anything is sent (#895)", async () => {
  const create = mock(async (_body: unknown) => ({ id: "wf-3" }));
  const validate = mock(async (_body: unknown) => ({ ok: true }));
  spyOn(runtime, "makeClient").mockReturnValue({
    getConnectorTemplateRecipe: async () => scraperRecipe(),
    validateWorkflowDraft: validate,
    createWorkflow: create,
  } as unknown as EngineClient);
  const written: string[] = [];
  spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  spyOn(process.stderr, "write").mockImplementation(() => true);

  await expect(
    saveWorkflow({ kind: "create" }, { "from-recipe": "web-scraper/fetch-page", json: true }),
  ).rejects.toThrow("recipe web-scraper/fetch-page needs install input site");

  expect(written.join("")).toContain("needs install input site");
  expect(validate).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
