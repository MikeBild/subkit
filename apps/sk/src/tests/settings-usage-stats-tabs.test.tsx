// Usage + Stats tabs (M5 of #159).
// Asserts both tabs render audit-derived data with empty-state and
// loaded-state coverage. Stats tab toggle keys are exercised.

import { describe, expect, mock, test } from "bun:test";
import type React from "react";
import type { EngineClient } from "../engine-client.ts";
import { SettingsModal } from "../settings-ui/SettingsModal.tsx";
import { renderInk } from "./helpers/ink.tsx";

function makeClient(items: Array<Record<string, unknown>>): EngineClient {
  return {
    skBootstrap: mock(async () => ({
      whoami: {
        id: "u1",
        kind: "user" as const,
        tenant_id: "t1",
        tenant_slug: "acme",
        email: "u@a.test",
        role_name: "admin",
        provider: "firebase",
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
    tailAuditLog: mock(async () => ({ items })),
  } as unknown as EngineClient;
}

async function navigateTo(
  client: EngineClient,
  steps: number,
): Promise<ReturnType<typeof renderInk>> {
  const node = (
    <SettingsModal
      sections={new Map()}
      pendingRestartKeys={[]}
      overrideKeys={[]}
      client={client}
      isAdmin={false}
      onExit={() => {}}
    />
  ) as React.ReactElement;
  const ui = renderInk(node);
  for (let i = 0; i < steps; i++) await ui.press("right");
  return ui;
}

describe("UsageTab — token aggregation by flow (M5 + G6 closure)", () => {
  test("renders top-5 flows from llm.invocation events with prompt + completion totals", async () => {
    const items = [
      {
        action: "llm.invocation",
        metadata: { flow: "chat", prompt_tokens: 1000, completion_tokens: 500 },
        created_at: "2024-11-14T22:13:20.000Z",
      },
      {
        action: "llm.invocation",
        metadata: { flow: "chat", prompt_tokens: 200, completion_tokens: 100 },
        created_at: "2024-11-14T22:13:20.000Z",
      },
      {
        action: "llm.invocation",
        metadata: { flow: "summarize", prompt_tokens: 800, completion_tokens: 50 },
        created_at: "2024-11-14T22:13:20.000Z",
      },
      {
        action: "llm.invocation",
        metadata: { flow: "tool-chain", prompt_tokens: 50, completion_tokens: 25 },
        created_at: "2024-11-14T22:13:20.000Z",
      },
      // Non-llm.invocation rows must be ignored.
      {
        action: "conversation.completed",
        metadata: { prompt_tokens: 9999 },
        created_at: "2024-11-14T22:13:20.000Z",
      },
    ];
    const ui = await navigateTo(makeClient(items), 3);
    try {
      await ui.waitFor((t) => t.includes("Token usage"));
      await ui.waitFor((t) => t.includes("chat") && t.includes("summarize"));
      const txt = ui.text();
      // chat: 1200 prompt + 600 completion = 1800
      expect(txt).toContain("chat");
      expect(txt).toContain("1,800");
      expect(txt).toContain("summarize");
      expect(txt).toContain("tool-chain");
      // grand totals row
      expect(txt).toMatch(/totals: 2,050 prompt \+ 675 completion = 2,725/);
      // conversation.completed should NOT have leaked in.
      expect(txt).not.toMatch(/9,999/);
    } finally {
      ui.unmount();
    }
  });

  test("renders empty state when no llm.invocation events exist", async () => {
    const ui = await navigateTo(makeClient([]), 3);
    try {
      await ui.waitFor((t) => t.includes("Token usage"));
      await ui.waitFor((t) => t.includes("no llm.invocation events found"));
      expect(ui.text()).toContain("no llm.invocation events");
    } finally {
      ui.unmount();
    }
  });
});

describe("StatsTab — heatmap (M5)", () => {
  test("renders heatmap and totals", async () => {
    const today = "2024-11-14T22:13:20.000Z";
    const items = Array.from({ length: 12 }, () => ({ created_at: today }));
    const ui = await navigateTo(makeClient(items), 4);
    try {
      await ui.waitFor((t) => t.includes("Activity heatmap"));
      await ui.waitFor((t) => /totals: 12 audit events/.test(t));
      expect(ui.text()).toContain("Last 30 days");
    } finally {
      ui.unmount();
    }
  });

  test("toggle '1' switches to Last 7 days window", async () => {
    const ui = await navigateTo(makeClient([]), 4);
    try {
      await ui.waitFor((t) => t.includes("Activity heatmap"));
      await ui.type("1");
      await ui.waitFor((t) => t.includes("current: Last 7 days"));
      expect(ui.text()).toContain("Last 7 days");
    } finally {
      ui.unmount();
    }
  });
});
