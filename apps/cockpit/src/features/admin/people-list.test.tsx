import { expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FilterBarLayoutContext } from "@ui/organisms/filter-bar";
import { renderInRouter } from "@/components/cockpit/patterns/test-utils";

mock.module("@/app/session", () => ({
  useSession: () => ({
    permissions: ["identity:read", "identity:write"],
    principal: { id: "me" },
    tenant: { origin: "hosted" },
  }),
}));
const { PeopleTab } = await import("./people-tab");

const person = (id: string, name: string, role: string, status: string) => ({
  id,
  email: `${id}@brennwerk.test`,
  display_name: name,
  role,
  status,
  created_at: "2026-11-01T10:00:00Z",
});

async function render(sheet: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } },
  });
  client.setQueryData(["admin", "people", "list", "all"], {
    pages: [
      {
        items: [
          person("lena", "Lena Hoffmann", "admin", "active"),
          person("miriam", "Miriam Schulz", "member", "invited"),
        ],
        next_cursor: null,
        total: 2,
      },
    ],
    pageParams: [null],
  });
  try {
    return await renderInRouter(
      <QueryClientProvider client={client}>
        <FilterBarLayoutContext.Provider value={sheet ? { presentation: "panel" } : {}}>
          <PeopleTab
            action={
              <button type="button" data-testid="people-invite">
                Person einladen
              </button>
            }
          />
        </FilterBarLayoutContext.Provider>
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

test("people is one list: search, filter and invite in one row, grouping in the Filter sheet", async () => {
  const markup = await render(false);
  expect(markup).toContain("Lena Hoffmann");
  expect(markup).toContain('data-testid="people-search"');
  expect(markup).toContain('data-testid="filter-bar-open"');
  expect(markup).toContain(">Person einladen<");
  expect(markup).not.toMatch(/role="tablist"[^>]*people-grouping/);
  expect(markup).toContain('style="width:4.5rem"');
  const sheet = await render(true);
  for (const filter of ["people-role-filter", "people-grouping"])
    expect(sheet).toContain(`data-testid="${filter}"`);
});
