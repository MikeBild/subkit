// Usage tab.
// Asserts the Usage tab renders month-to-date token usage sourced from
// the tenant-scoped /v1/stats/llm endpoint (grouped by flow) plus the
// monthly budget denominator from /v1/status. The former audit-log
// (`llm.invocation`) scrape is gone. The former Stats tab lives as an
// embedded ActivityHeatmap in the Status tab — coverage in
// apps/sk/src/settings-ui/__tests__/StatusTab.heatmap.ink.test.tsx.

import { describe, expect, mock, test } from "bun:test";
import type React from "react";
import type { EngineClient } from "../engine-client.ts";
import { SettingsModal } from "../settings-ui/SettingsModal.tsx";
import { renderInk } from "./helpers/ink.tsx";

interface FlowTokens {
  flow: string;
  prompt: number;
  completion: number;
  total: number;
}

/** Minimal /v1/stats/llm response — the UsageTab reads only
 *  groups[].key.flow, groups[].totals.tokens, and totals.tokens. */
function statsLlmResponse(flows: FlowTokens[]) {
  const sum = (k: "prompt" | "completion" | "total") => flows.reduce((acc, f) => acc + f[k], 0);
  return {
    bucket: "day",
    tz: "UTC",
    from: "2024-11-01T00:00:00.000Z",
    to: "2024-11-30T00:00:00.000Z",
    groups: flows.map((f) => ({
      key: { flow: f.flow },
      buckets: [],
      totals: {
        tokens: {
          prompt: f.prompt,
          completion: f.completion,
          cache_read: 0,
          cache_creation: 0,
          total: f.total,
        },
      },
    })),
    totals: {
      tokens: {
        prompt: sum("prompt"),
        completion: sum("completion"),
        cache_read: 0,
        cache_creation: 0,
        total: sum("total"),
      },
    },
  };
}

function makeClient(flows: FlowTokens[], budget: number | null = null): EngineClient {
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
    statsLlm: mock(async () => statsLlmResponse(flows)),
    statusSummary: mock(async () => ({ monthly_budget_tokens: budget })),
  } as unknown as EngineClient;
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

describe("UsageTab — token aggregation by flow (M5 + G6 closure)", () => {
  test("renders top-5 flows from /v1/stats/llm with prompt + completion totals", async () => {
    const flows: FlowTokens[] = [
      { flow: "chat", prompt: 1200, completion: 600, total: 1800 },
      { flow: "summarize", prompt: 800, completion: 50, total: 850 },
      { flow: "tool-chain", prompt: 50, completion: 25, total: 75 },
    ];
    const ui = await navigateTo(makeClient(flows), 2);
    try {
      await ui.waitFor((t) => t.includes("Token usage"));
      await ui.waitFor((t) => t.includes("chat") && t.includes("summarize"));
      const txt = ui.text();
      // chat: 1200 prompt + 600 completion = 1800 total
      expect(txt).toContain("chat");
      expect(txt).toContain("1,800");
      expect(txt).toContain("summarize");
      expect(txt).toContain("tool-chain");
      // window totals row: 2,050 input + 675 output = 2,725 tokens
      expect(txt).toMatch(/totals: 2,050 input \+ 675 output = 2,725 tokens/);
      // no budget configured → unlimited
      expect(txt).toContain("monthly budget: unlimited");
    } finally {
      ui.unmount();
    }
  });

  test("renders empty state when no AI requests recorded", async () => {
    const ui = await navigateTo(makeClient([]), 2);
    try {
      await ui.waitFor((t) => t.includes("Token usage"));
      await ui.waitFor((t) => t.includes("no AI requests recorded"));
      expect(ui.text()).toContain("no AI requests recorded for this tenant this month");
    } finally {
      ui.unmount();
    }
  });
});
