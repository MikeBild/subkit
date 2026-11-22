import { describe, expect, mock, test } from "bun:test";
import type React from "react";
import type { EngineClient } from "../engine-client.ts";
import { SettingsModal } from "../settings-ui/SettingsModal.tsx";
import { renderInk } from "./helpers/ink.tsx";

function makeClient(opts: { knowledgeSources?: Array<Record<string, unknown>>; email?: string }): {
  client: EngineClient;
  deleteKs: ReturnType<typeof mock>;
} {
  const deleteKs = mock(async () => undefined);
  const client = {
    subkitBootstrap: mock(async () => ({
      whoami: {
        id: "u1",
        kind: "user" as const,
        tenant_id: "t1",
        tenant_slug: "acme",
        email: opts.email ?? "alice@acme.test",
        role_name: "admin",
        provider: "workforce",
        base_url: "http://localhost:3000",
        scopes: null,
      },
      permissions: [],
      permissions_checked: [],
      tenant: { id: "t1", slug: "acme", display_name: null },
      recent_sessions: [],
      flags: {},
      server_time: "2026-05-09T00:00:00Z",
    })),
    listMcpTools: mock(async () => ({ items: [] })),
    listMcpPrompts: mock(async () => ({ items: [] })),
    listMcpResources: mock(async () => ({ items: [] })),
    tailAuditLog: mock(async () => ({ items: [] })),
    listSkills: mock(async () => ({ items: [] })),
    listKnowledgeSources: mock(async () => ({ items: opts.knowledgeSources ?? [] })),
    deleteKnowledgeSource: deleteKs,
  } as unknown as EngineClient;
  return { client, deleteKs };
}

async function navigateTo(
  client: EngineClient,
  steps: number,
): Promise<ReturnType<typeof renderInk>> {
  const node = (
    <SettingsModal
      fields={[]}
      pendingRestartKeys={[]}
      overrideKeys={[]}
      client={client}
      onExit={() => {}}
    />
  ) as React.ReactElement;
  const ui = renderInk(node);
  for (let i = 0; i < steps; i++) await ui.press("right");
  return ui;
}

describe("KnowledgeTab — inline ingest (G8 closure)", () => {
  test("'i' opens the ingest path prompt; Enter calls createKnowledgeSource", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "subkit-ingest-"));
    const filepath = join(tmp, "playbook.md");
    writeFileSync(filepath, "# my notes\nhello world", "utf8");

    const createKnowledgeSource = mock(async () => ({ id: "k99", name: "playbook.md" }));
    const listKnowledgeSources = mock(async () => ({ items: [] }));
    const client = {
      subkitBootstrap: mock(async () => ({
        whoami: {
          id: "u1",
          kind: "user" as const,
          tenant_id: "t1",
          tenant_slug: "acme",
          email: "u@a.test",
          role_name: "admin",
          provider: "workforce",
          base_url: "http://localhost:3000",
          scopes: null,
        },
        permissions: [],
        permissions_checked: [],
        tenant: { id: "t1", slug: "acme", display_name: null },
        recent_sessions: [],
        flags: {},
        server_time: "2024-11-14T22:13:20.000Z",
      })),
      listMcpTools: mock(async () => ({ items: [] })),
      listMcpPrompts: mock(async () => ({ items: [] })),
      listMcpResources: mock(async () => ({ items: [] })),
      tailAuditLog: mock(async () => ({ items: [] })),
      listSkills: mock(async () => ({ items: [] })),
      listKnowledgeSources,
      createKnowledgeSource,
      deleteKnowledgeSource: mock(async () => undefined),
    } as unknown as EngineClient;

    const ui = await navigateTo(client, 4);
    try {
      await ui.waitFor((t) => t.includes("Knowledge sources"));
      await ui.type("i");
      await ui.waitFor((t) => t.includes("Ingest knowledge source"));
      for (const ch of filepath) await ui.type(ch);
      await ui.press("enter");
      await ui.waitFor(() => createKnowledgeSource.mock.calls.length > 0, {
        tries: 100,
        sleepMs: 5,
      });
      expect(createKnowledgeSource.mock.calls.length).toBe(1);
      const args0 = createKnowledgeSource.mock.calls[0] as unknown as [
        { name: string; mime_type: string; content: Buffer },
        ...unknown[],
      ];
      expect(args0[0].name).toBe("playbook.md");
      expect(args0[0].mime_type).toBe("text/markdown");
      expect(args0).toHaveLength(1);
    } finally {
      ui.unmount();
    }
  });
});

describe("KnowledgeTab (M7)", () => {
  test("renders knowledge sources from engine", async () => {
    const { client } = makeClient({
      knowledgeSources: [
        { id: "k1", name: "playbook.md", status: "active", updated_at: "2026-05-01T12:00:00Z" },
        { id: "k2", name: "incidents.md", status: "processing" },
      ],
    });
    const ui = await navigateTo(client, 4);
    try {
      await ui.waitFor((t) => t.includes("Knowledge sources"));
      await ui.waitFor((t) => t.includes("playbook.md"));
      const txt = ui.text();
      expect(txt).toContain("playbook.md");
      expect(txt).toContain("[active]");
      expect(txt).toContain("incidents.md");
      expect(txt).toContain("[processing]");
    } finally {
      ui.unmount();
    }
  });

  test("shows last_refreshed_at, falling back to updated_at", async () => {
    const { client } = makeClient({
      knowledgeSources: [
        {
          id: "k1",
          name: "playbook.md",
          status: "active",
          last_refreshed_at: "2026-06-01T08:00:00Z",
          updated_at: "2026-05-01T12:00:00Z",
        },
        {
          id: "k2",
          name: "incidents.md",
          status: "active",
          last_refreshed_at: null,
          updated_at: "2026-04-01T12:00:00Z",
        },
      ],
    });
    const ui = await navigateTo(client, 4);
    try {
      await ui.waitFor((t) => t.includes("incidents.md"));
      const txt = ui.text();
      expect(txt).toContain("2026-06-01T08:00:00Z");
      expect(txt).not.toContain("2026-05-01T12:00:00Z");
      expect(txt).toContain("2026-04-01T12:00:00Z");
    } finally {
      ui.unmount();
    }
  });

  test("`d` opens delete confirmation; `1` confirms and calls deleteKnowledgeSource", async () => {
    const { client, deleteKs } = makeClient({
      knowledgeSources: [{ id: "k1", name: "playbook.md", status: "active" }],
    });
    const ui = await navigateTo(client, 4);
    try {
      await ui.waitFor((t) => t.includes("playbook.md"));
      await ui.type("d");
      await ui.waitFor((t) => t.includes('Delete "playbook.md"?'));
      await ui.type("1");
      await ui.waitFor(() => deleteKs.mock.calls.length > 0, { tries: 50, sleepMs: 5 });
      expect(deleteKs.mock.calls.length).toBe(1);
      expect(deleteKs.mock.calls[0]?.[0]).toBe("k1");
    } finally {
      ui.unmount();
    }
  });

  test("renders empty state when no sources", async () => {
    const { client } = makeClient({ knowledgeSources: [] });
    const ui = await navigateTo(client, 4);
    try {
      await ui.waitFor((t) => t.includes("Knowledge sources"));
      await ui.waitFor((t) => t.includes("no knowledge sources"));
      expect(ui.text()).toContain("no knowledge sources");
    } finally {
      ui.unmount();
    }
  });
});

describe("ProfileTab (M7) — rendered direct, no longer reachable from /settings", () => {
  async function renderProfile(opts: { email?: string } = {}): Promise<{
    ui: ReturnType<typeof renderInk>;
    fired: string[];
  }> {
    const { client } = makeClient(opts);
    const { ProfileTab } = await import("../settings-ui/tabs/ProfileTab.tsx");
    const fired: string[] = [];
    const ui = renderInk(
      <ProfileTab
        client={client}
        onAction={(a) => {
          fired.push(a.kind);
        }}
      />,
    );
    return { ui, fired };
  }

  test("renders identity card from subkitBootstrap", async () => {
    const { ui } = await renderProfile({ email: "carol@acme.test" });
    try {
      await ui.waitFor((t) => t.includes("carol@acme.test"));
      const txt = ui.text();
      expect(txt).toContain("carol@acme.test");
      expect(txt).toContain("acme");
      expect(txt).toContain("admin");
      expect(txt).toContain("workforce");
      expect(txt).toContain("http://localhost:3000");
    } finally {
      ui.unmount();
    }
  });

  test("renders inline action menu (G7 closure replaces CLI hint)", async () => {
    const { ui } = await renderProfile();
    try {
      await ui.waitFor((t) => t.includes("Profile"));
      await ui.waitFor((t) => t.includes("Start a new session"));
      const txt = ui.text();
      expect(txt).toContain("n Start a new session");
      expect(txt).toContain("t Switch tenant");
      expect(txt).toContain("s Sign out");
    } finally {
      ui.unmount();
    }
  });

  test("'n' fires the new-session action sink (G7)", async () => {
    const { ui, fired } = await renderProfile();
    try {
      await ui.waitFor((t) => t.includes("Profile"));
      await ui.type("n");
      await ui.waitFor(() => fired.length > 0, { tries: 50, sleepMs: 5 });
      expect(fired).toContain("new-session");
    } finally {
      ui.unmount();
    }
  });
});
