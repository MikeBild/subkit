import { expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FilterBarLayoutContext } from "@ui/organisms/filter-bar";
import type { ReactElement } from "react";
import { loginHref } from "@/app/login-href";
import { renderInRouter } from "@/components/cockpit/patterns/test-utils";

let permissions: string[] = [];
mock.module("@/app/session", () => ({
  loginHref,
  useSession: () => ({ permissions }),
  useSessionUpdate: () => () => {},
}));

const { InboxPage, SkillsPage } = await import("./index");
const { KEYS } = await import("./queries");

function seeded(data: [readonly unknown[], unknown][]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } },
  });
  for (const [key, value] of data) client.setQueryData(key, value);
  return client;
}

async function html(client: QueryClient, element: ReactElement, sheet = false) {
  try {
    return await renderInRouter(
      <QueryClientProvider client={client}>
        <FilterBarLayoutContext.Provider value={sheet ? { presentation: "panel" } : {}}>
          {element}
        </FilterBarLayoutContext.Provider>
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

const clip = {
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "t",
  category: "operations",
  client_request_id: "c",
  title: "Lieferavise ohne Bestellnummer",
  body: "Text",
  note: "",
  state: "collected",
  version: 1,
  collected_by: { kind: "user", id: "u" },
  admitted_target_kind: null,
  admitted_target_id: null,
  created_at: "2026-11-20T10:00:00Z",
  updated_at: "2026-11-20T10:00:00Z",
  original_snapshot: { origin: "note", title: "t", captured_at: "2026-11-20T10:00:00Z", body: "b" },
  attachment: {
    file_id: "f1",
    filename: "Avis.pdf",
    content_type: "application/pdf",
    size_bytes: 120_000,
    status: "ready",
  },
};

test("an empty inbox shows the flow and the first-run card with the note action", async () => {
  permissions = ["intake:read", "intake:write"];
  const markup = await html(
    seeded([
      [KEYS.entries, { items: [] }],
      [KEYS.proposals, { items: [] }],
    ]),
    <InboxPage />,
  );
  expect(markup).toContain('data-testid="knowledge-inbox"');
  expect(markup).toContain("Du sammelst");
  expect(markup).toContain("So kommt Wissen in SubKit");
  expect(markup).toContain('data-testid="kn-inbox-addNote"');
});

test("an inbox row names the attachment with its size instead of the origin", async () => {
  permissions = ["intake:read"];
  const markup = await html(
    seeded([
      [KEYS.entries, { items: [clip] }],
      [KEYS.proposals, { items: [] }],
    ]),
    <InboxPage />,
  );
  expect(markup).toContain("Lieferavise ohne Bestellnummer");
  expect(markup).toContain("Avis.pdf · 117 KB");
  expect(markup).toContain("1 Eintrag · 1 warten auf Prüfung");
  expect(markup).not.toContain('data-testid="kn-inbox-add"');
});

test("the inbox list has one toolbar row and keeps every filter in the Filter sheet", async () => {
  permissions = ["intake:read"];
  const seed = () =>
    seeded([
      [KEYS.entries, { items: [clip] }],
      [KEYS.proposals, { items: [] }],
    ]);
  const markup = await html(seed(), <InboxPage />);
  expect(markup).toContain('data-testid="filter-bar-open"');
  expect(markup).not.toContain('data-testid="kn-inbox-state"');
  const sheet = await html(seed(), <InboxPage />, true);
  for (const filter of ["kn-inbox-state", "kn-inbox-origin", "kn-group"])
    expect(sheet).toContain(`data-testid="${filter}"`);
});

test("the skills list hides creation without skill:write", async () => {
  permissions = ["skill:read"];
  const skill = {
    id: "s1",
    title: "Tonalität",
    status: "active",
    applies_to: "both",
    scope: "global",
    category: "writing",
    version: 2,
    body: "# T\n\n- kurz",
    updated_at: "2026-11-20T10:00:00Z",
    created_at: "2026-11-01T10:00:00Z",
  };
  const markup = await html(seeded([[KEYS.skills, { items: [skill], total: 1 }]]), <SkillsPage />);
  expect(markup).toContain("Tonalität");
  expect(markup).toContain("Aktiv");
  expect(markup).not.toContain('data-testid="kn-skills-create"');
  expect(markup.match(/hidden @4xl:table-cell/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  const sheet = await html(
    seeded([[KEYS.skills, { items: [skill], total: 1 }]]),
    <SkillsPage />,
    true,
  );
  for (const filter of ["kn-created-by", "kn-group"])
    expect(sheet).toContain(`data-testid="${filter}"`);
});

test("a list cut off at the page cap says only the loaded entries are searched", async () => {
  permissions = ["skill:read"];
  const items = Array.from({ length: 2000 }, (_, i) => ({
    id: `s${i}`,
    title: `Skill ${i}`,
    status: "active",
    applies_to: "both",
    scope: "global",
    category: "writing",
    version: 1,
    body: "",
    updated_at: "2026-11-20T10:00:00Z",
    created_at: "2026-11-01T10:00:00Z",
  }));
  const markup = await html(
    seeded([[KEYS.skills, { items, total: 2001, truncated: true }]]),
    <SkillsPage />,
  );
  expect(markup).toContain('data-testid="kn-list-partial"');
  expect(markup).toContain("2.000 von 2.001");
});
