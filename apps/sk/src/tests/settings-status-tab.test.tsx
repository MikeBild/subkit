// Status tab — runtime snapshot + 5s MCP polling.
// Asserts the tab renders identity rows from skBootstrap, MCP catalog
// counts from listMcp* endpoints, and that the polling timer is
// cleared when the tab unmounts (no-leak assertion).

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type React from "react";

import type { EngineClient } from "../engine-client.ts";
import type { FormField } from "../settings-ui/lib/zod-to-form-fields.ts";
import { SettingsModal } from "../settings-ui/SettingsModal.tsx";
import { renderInk } from "./helpers/ink.tsx";

let realSetInterval: typeof globalThis.setInterval;
let realClearInterval: typeof globalThis.clearInterval;
const liveTimers = new Set<{ id: unknown; cleared: boolean }>();

beforeEach(() => {
  realSetInterval = globalThis.setInterval;
  realClearInterval = globalThis.clearInterval;
  liveTimers.clear();
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    const handle = realSetInterval(fn, ms);
    const entry = { id: handle, cleared: false };
    liveTimers.add(entry);
    return handle;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((id: unknown) => {
    for (const t of liveTimers) {
      if (t.id === id) {
        t.cleared = true;
      }
    }
    realClearInterval(id as Parameters<typeof realClearInterval>[0]);
  }) as typeof globalThis.clearInterval;
});

afterEach(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  // Clear any leftover timers so they can't fire after the test exits.
  for (const t of liveTimers) {
    if (!t.cleared) realClearInterval(t.id as Parameters<typeof realClearInterval>[0]);
  }
  liveTimers.clear();
});

function makeClient(opts: {
  bootstrapEmail?: string;
  bootstrapTenant?: string;
  toolCount?: number;
  promptCount?: number;
  resourceCount?: number;
}): EngineClient {
  const skBootstrap = mock(async () => ({
    whoami: {
      id: "u1",
      kind: "user" as const,
      tenant_id: "t1",
      tenant_slug: opts.bootstrapTenant ?? "acme",
      email: opts.bootstrapEmail ?? "user@example.com",
      role_name: "admin",
      provider: "workforce",
      base_url: "http://localhost:3000",
      scopes: null,
    },
    permissions: ["audit:read", "rbac:read"],
    permissions_checked: [],
    tenant: { id: "t1", slug: opts.bootstrapTenant ?? "acme", display_name: null },
    recent_sessions: [],
    flags: {},
    server_time: "2024-11-14T22:13:20.000Z",
  }));
  const listMcpTools = mock(async () => ({
    items: Array.from({ length: opts.toolCount ?? 3 }, (_, i) => ({
      name: `tool_${i}`,
      description: "",
      input_shape: {},
    })),
  }));
  const listMcpPrompts = mock(async () => ({
    items: Array.from({ length: opts.promptCount ?? 2 }, (_, i) => ({
      name: `prompt_${i}`,
      description: null,
      scope: "tenant",
      skill_id: "s1",
    })),
  }));
  const listMcpResources = mock(async () => ({
    items: Array.from({ length: opts.resourceCount ?? 1 }, (_, i) => ({
      uri: `urn:r:${i}`,
      name: `r${i}`,
      description: null,
      mime_type: null,
    })),
  }));
  // The Status tab now embeds the ActivityHeatmap, which fetches the
  // audit log. Stub it to an empty result so the heatmap doesn't render
  // a `failed:` row and collide with the MCP-failure assertion below.
  const tailAuditLog = mock(async () => ({ items: [] }));
  return {
    skBootstrap,
    listMcpTools,
    listMcpPrompts,
    listMcpResources,
    tailAuditLog,
  } as unknown as EngineClient;
}

function makeFields(): FormField[] {
  return [
    {
      path: "llm.model",
      kind: "text",
      value: "claude-opus-4-7",
      scope: "global",
      sensitive: false,
      requiresRestart: false,
      source: "global",
      description: "active model",
    },
  ];
}

async function renderOnStatusTab(client: EngineClient): Promise<ReturnType<typeof renderInk>> {
  const node = (
    <SettingsModal
      fields={makeFields()}
      pendingRestartKeys={[]}
      overrideKeys={[]}
      client={client}
      onExit={() => {}}
    />
  ) as React.ReactElement;
  const ui = renderInk(node);
  // Status is the default landing tab (idx 0) — no navigation needed.
  await ui.waitFor((t) => t.includes("Runtime status"));
  return ui;
}

describe("StatusTab — runtime snapshot + MCP polling (M4)", () => {
  test("renders identity rows from skBootstrap", async () => {
    const client = makeClient({
      bootstrapEmail: "alice@acme.test",
      bootstrapTenant: "acme",
    });
    const ui = await renderOnStatusTab(client);
    try {
      await ui.waitFor((t) => t.includes("alice@acme.test"));
      const txt = ui.text();
      expect(txt).toContain("alice@acme.test");
      expect(txt).toContain("acme");
      expect(txt).toContain("admin");
      expect(txt).toContain("http://localhost:3000");
      expect(txt).toContain("claude-opus-4-7");
    } finally {
      ui.unmount();
    }
  });

  test("renders MCP catalog counts after first poll", async () => {
    const client = makeClient({ toolCount: 5, promptCount: 3, resourceCount: 7 });
    const ui = await renderOnStatusTab(client);
    try {
      await ui.waitFor((t) => /5 tools/.test(t));
      const txt = ui.text();
      expect(txt).toContain("5 tools");
      expect(txt).toContain("3 prompts");
      expect(txt).toContain("7 resources");
    } finally {
      ui.unmount();
    }
  });

  test("MCP polling timer is cleared when tab is switched away (no-leak)", async () => {
    const client = makeClient({ toolCount: 1 });
    const ui = await renderOnStatusTab(client);
    try {
      await ui.waitFor((t) => /1 tools/.test(t));
      const beforeSwitch = liveTimers.size;
      expect(beforeSwitch).toBeGreaterThan(0);
      // Switch back to Settings tab — Status component unmounts.
      await ui.press("left");
      await ui.waitFor((t) => !t.includes("Runtime status"), { tries: 50, sleepMs: 5 });
      // After unmount, every timer the StatusTab created should be cleared.
      const stillLive = [...liveTimers].filter((t) => !t.cleared);
      expect(stillLive.length).toBe(0);
    } finally {
      ui.unmount();
    }
  });

  test("renders REPL-state rows when sessionId / permissionMode / tokens are passed", async () => {
    const client = makeClient({});
    const ui = renderInk(
      <SettingsModal
        fields={makeFields()}
        pendingRestartKeys={[]}
        overrideKeys={[]}
        client={client}
        sessionId="abc12345-def6-7890-abcd-ef1234567890"
        sessionTitle="my migration draft"
        permissionMode="auto"
        sessionTokens={1234}
        weekTokens={56789}
        onExit={() => {}}
      />,
    );
    try {
      // Status is the default landing tab (idx 0).
      await ui.waitFor((t) => t.includes("Runtime status"));
      const txt = ui.text();
      expect(txt).toContain("abc12345");
      expect(txt).toContain("my migration draft");
      expect(txt).toContain("auto");
      expect(txt).toContain("1,234");
      expect(txt).toContain("56,789");
    } finally {
      ui.unmount();
    }
  });

  test("renders '—' for REPL-state rows when not threaded", async () => {
    const client = makeClient({});
    const ui = renderInk(
      <SettingsModal
        fields={makeFields()}
        pendingRestartKeys={[]}
        overrideKeys={[]}
        client={client}
        onExit={() => {}}
      />,
    );
    try {
      // Status is the default landing tab (idx 0).
      await ui.waitFor((t) => t.includes("Runtime status"));
      const txt = ui.text();
      // Permission mode + token counters should fall back to "—" when
      // the host doesn't pass REPL state.
      expect(txt).toMatch(/permission mode\s+—/);
      expect(txt).toMatch(/tokens · session\s+—/);
      expect(txt).toMatch(/tokens · this week\s+—/);
    } finally {
      ui.unmount();
    }
  });

  test("renders 'failed: <reason>' when MCP fetch errors out", async () => {
    const client = {
      skBootstrap: mock(async () => ({
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
      listMcpTools: mock(async () => {
        throw new Error("ECONNREFUSED");
      }),
      listMcpPrompts: mock(async () => ({ items: [] })),
      listMcpResources: mock(async () => ({ items: [] })),
      tailAuditLog: mock(async () => ({ items: [] })),
    } as unknown as EngineClient;
    const ui = await renderOnStatusTab(client);
    try {
      await ui.waitFor((t) => t.includes("ECONNREFUSED"));
      expect(ui.text()).toContain("ECONNREFUSED");
    } finally {
      ui.unmount();
    }
  });
});
