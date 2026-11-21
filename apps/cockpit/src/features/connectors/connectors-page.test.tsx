import { expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FilterBarLayoutContext } from "@/components/cockpit/patterns/filter-bar";
import { renderInRouter } from "@/components/cockpit/patterns/test-utils";

mock.module("@/app/session", () => ({ useSession: () => ({ permissions: ["connector:read"] }) }));
const { ConnectorsPage } = await import("./index");

const connector = (id: string, name: string, over: Record<string, unknown>) => ({
  id,
  display_name: name,
  slug: name.toLowerCase(),
  environment: "prod",
  health_state: "ok",
  needs_reauth: false,
  auth_type: "oauth2",
  last_tested_at: "2026-11-20T10:00:00Z",
  updated_at: "2026-11-20T10:00:00Z",
  enabled: true,
  category: "communication",
  ...over,
});

test("a connector that needs sign-in shows the re-sign-in notice first; healthy ones a test button", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } },
  });
  client.setQueryData(["catalog", "connectors", "cards"], {
    items: [
      connector("a", "Gmail", {}),
      connector("b", "HubSpot", { needs_reauth: true, environment: "dev" }),
    ],
    total: 2,
  });
  try {
    const markup = await renderInRouter(
      <QueryClientProvider client={client}>
        <ConnectorsPage />
      </QueryClientProvider>,
    );
    expect(markup.indexOf("HubSpot")).toBeLessThan(markup.indexOf("Gmail"));
    expect(markup).toContain("Neu anmelden");
    expect(markup).toContain("Echtbetrieb");
    expect(markup).toContain('data-testid="cn-test"');
    expect(markup).toContain('data-testid="kn-search"');
    expect(markup).toContain('data-testid="filter-bar-open"');
    expect(markup).not.toContain('data-testid="cn-kind"');
    expect(markup).not.toContain('data-testid="connectors-create"');
    const sheet = await renderInRouter(
      <QueryClientProvider client={client}>
        <FilterBarLayoutContext.Provider value={{ presentation: "panel" }}>
          <ConnectorsPage />
        </FilterBarLayoutContext.Provider>
      </QueryClientProvider>,
    );
    for (const filter of ["cn-filter", "cn-kind", "cn-sort", "kn-created-by", "kn-group"])
      expect(sheet).toContain(`data-testid="${filter}"`);
  } finally {
    client.clear();
  }
});
