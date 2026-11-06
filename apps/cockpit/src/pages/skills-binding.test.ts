import { afterEach, expect, spyOn, test } from "bun:test";
import { loadSkillBindingName } from "./skills";

const fetchPreconnect = globalThis.fetch.preconnect;
const mocks: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
});

function answer(body: unknown): string[] {
  const urls: string[] = [];
  mocks.push(
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          urls.push(String(input));
          return Response.json(body);
        },
        { preconnect: fetchPreconnect },
      ),
    ),
  );
  return urls;
}

test("a connector-bound skill names the connector by its display_name", async () => {
  const urls = answer({ id: "c-1", slug: "crm", display_name: "CRM Live" });
  const name = await loadSkillBindingName({
    scope: "connector",
    connector_id: "c-1",
    workflow_id: null,
  });
  expect(name).toBe("CRM Live");
  expect(urls[0]).toEndWith("/v1/connectors/c-1");
});

test("a workflow-bound skill names the workflow", async () => {
  const urls = answer({ id: "w-1", name: "Invoice sync" });
  const name = await loadSkillBindingName({
    scope: "workflow",
    workflow_id: "w-1",
    connector_id: null,
  });
  expect(name).toBe("Invoice sync");
  expect(urls[0]).toEndWith("/v1/workflows/w-1");
});
