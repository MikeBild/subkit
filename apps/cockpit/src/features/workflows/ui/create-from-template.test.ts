import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TEMPLATES_KEY, useSolutionTemplates } from "./create-from-template";

const packKey = ["recipe-packs", "solutions"];

function readTemplates(client: QueryClient) {
  let result: ReturnType<typeof useSolutionTemplates> | undefined;
  function Probe() {
    result = useSolutionTemplates(true);
    return null;
  }
  renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)));
  if (!result) throw new Error("Missing template query state");
  return result;
}

test("template gallery waits for the connector-template catalog", () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  try {
    client.setQueryData(packKey, { recipes: [] });
    expect(readTemplates(client).pending).toBe(true);
  } finally {
    client.clear();
  }
});

test("template gallery exposes catalog failures and retries both sources", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  try {
    client.setQueryData(packKey, { recipes: [] });
    await client
      .fetchQuery({
        queryKey: TEMPLATES_KEY,
        queryFn: () => Promise.reject(new Error("Catalog unavailable")),
      })
      .catch(() => undefined);
    const templates = readTemplates(client);
    expect(templates.pending).toBe(false);
    expect(templates.failed).toBe(true);
    const fetching: unknown[] = [];
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "fetch") {
        fetching.push(event.query.queryKey);
      }
    });
    templates.retry();
    unsubscribe();
    expect(fetching).toContainEqual(packKey);
    expect(fetching).toContainEqual(TEMPLATES_KEY);
  } finally {
    client.clear();
  }
});
