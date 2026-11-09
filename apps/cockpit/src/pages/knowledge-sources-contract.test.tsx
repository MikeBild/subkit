import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@/components/cockpit/patterns/test-utils";
import { KnowledgeSourcesPage } from "@/pages/knowledge-sources";

test("renders the knowledge collection's access boundary without starting its catalog query", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <KnowledgeSourcesPage permissions={[]} /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  try {
    await router.load();
    const markup = render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(markup).toContain('data-testid="catalog-knowledge"');
    expect(markup).toContain('data-testid="resource-permission-alert"');
    const catalogQueries = client
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey[0] === "catalog");
    expect(catalogQueries.length).toBeGreaterThan(0);
    expect(catalogQueries.every((query) => query.state.fetchStatus === "idle")).toBe(true);
  } finally {
    client.clear();
  }
});
