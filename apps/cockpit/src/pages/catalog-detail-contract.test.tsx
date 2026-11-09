import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { render } from "@/components/cockpit/patterns/test-utils";
import { CatalogDetailPage } from "@/pages/catalog-detail";

test("does not request or disclose a catalog record when the route lacks its read permission", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/connectors/connector-1",
  });
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const markup = render(
      <QueryClientProvider client={client}>
        <CatalogDetailPage resource="connectors" permissions={[]} />
      </QueryClientProvider>,
    );

    expect(markup).toContain('data-testid="resource-permission-alert"');
    expect(markup).toContain("Dafür fehlen dir die Rechte.");
    expect(markup).not.toContain("connector-1");
    expect(client.getQueryCache().getAll()).toHaveLength(1);
    expect(client.getQueryCache().getAll()[0]?.state.fetchStatus).toBe("idle");
  } finally {
    client.clear();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
    dom.window.close();
  }
});
