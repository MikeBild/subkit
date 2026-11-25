import { describe, expect, test } from "bun:test";
import { pinInstallInputs } from "@shared/recipe-install-inputs.ts";
import {
  type ConnectorTemplate,
  findSolution,
  hostListValues,
  installInputFields,
  installInputProblem,
  planSolution,
  recipeEntryKey,
  type SolutionEntry,
  solutionDraftBody,
  templateRecipeEntries,
} from "./create-template-model";

describe("connector template recipes with install inputs (#895)", () => {
  const fetchRecipe = (overrides: Record<string, unknown> = {}) => ({
    slug: "fetch-url-as-markdown",
    title: "Fetch a page as markdown",
    description: "Fetches one page on the listed hosts.",
    category: "productivity",
    tags: ["scrape"],
    difficulty: "beginner",
    install_inputs: ["allowed_hosts"],
    required_connectors: [],
    sample_input: { url: "https://docs.example.com/" },
    workflow: {
      name: "fetch-url-as-markdown",
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string" },
          allowed_hosts: { type: "array", items: { type: "string" }, title: "Allowed hosts" },
        },
      },
      steps: [
        {
          kind: "request",
          id: "fetch",
          url: `\${input.url}`,
          boundary: { allowed_hosts: `\${input.allowed_hosts}` },
        },
      ],
    },
    ...overrides,
  });
  const scraper = (recipes: unknown[]) =>
    ({ slug: "web-scraper", recipes }) as unknown as Pick<ConnectorTemplate, "slug" | "recipes">;
  const entry = (): SolutionEntry => {
    const [first] = templateRecipeEntries([scraper([fetchRecipe()])]);
    if (!first) throw new Error("template recipe entry missing");
    return first;
  };

  test("only template recipes that ask for install inputs and need no connector are offered", () => {
    const entries = templateRecipeEntries([
      scraper([
        fetchRecipe(),
        fetchRecipe({ slug: "no-inputs", install_inputs: [] }),
        fetchRecipe({
          slug: "needs-connector",
          required_connectors: [
            { placeholder: "52000000-0000-4000-8000-000000000001", template: "google-analytics" },
          ],
        }),
      ]),
    ]);
    expect(entries.map(recipeEntryKey)).toEqual(["web-scraper/fetch-url-as-markdown"]);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        template_slug: "web-scraper",
        recipe_slug: "fetch-url-as-markdown",
        connectors: [],
        install_inputs: ["allowed_hosts"],
      }),
    );
    expect(findSolution(entries, "web-scraper/fetch-url-as-markdown")).toBe(entries[0] ?? null);
    expect(findSolution(entries, "fetch-url-as-markdown")).toBeNull();
    expect(recipeEntryKey({ template_slug: null, recipe_slug: "daily-analytics-report" })).toBe(
      "daily-analytics-report",
    );
  });

  test("an array install input becomes a host list field", () => {
    expect(installInputFields(entry())).toEqual([
      { key: "allowed_hosts", label: "Allowed hosts", list: true },
    ]);
  });

  test("a host list is read one host per line or comma and checked with the shared rule", () => {
    expect(hostListValues(" docs.example.com\nexample.com, ,\n")).toEqual([
      "docs.example.com",
      "example.com",
    ]);
    expect(installInputProblem(entry(), {})).toBe("create.solution.inputMissing");
    expect(installInputProblem(entry(), { allowed_hosts: " \n " })).toBe(
      "create.solution.inputMissing",
    );
    for (const invalid of ["https://example.com", "*.example.com", "example.com:8443", "10.0.0.1"])
      expect(installInputProblem(entry(), { allowed_hosts: invalid })).toBe(
        "create.solution.hostsInvalid",
      );
    const hosts = ["docs.example.com", "example.com"];
    const sharedRule = pinInstallInputs(entry().workflow, ["allowed_hosts"], {
      allowed_hosts: hosts,
    });
    expect(sharedRule.ok).toBe(true);
    expect(installInputProblem(entry(), { allowed_hosts: hosts.join("\n") })).toBeNull();
  });

  test("the draft sends the host list with the template recipe as its origin", () => {
    const plan = planSolution(entry(), { choices: {}, created: {}, takenSlugs: new Set() });
    const body = solutionDraftBody(entry(), plan, {}, { allowed_hosts: "docs.example.com\n" });
    expect(body.recipe).toEqual({
      template: "web-scraper",
      slug: "fetch-url-as-markdown",
      inputs: { allowed_hosts: ["docs.example.com"] },
    });
    expect(body.definition.slug).toBe("fetch-url-as-markdown");
  });
});
