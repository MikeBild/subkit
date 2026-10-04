import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { EngineClient } from "../../engine-client.ts";
import { renderInk } from "../../tests/helpers/ink.tsx";
import type { FormField } from "../lib/zod-to-form-fields.ts";
import { StatusTab } from "../tabs/StatusTab.tsx";

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
  for (const t of liveTimers) {
    if (!t.cleared) realClearInterval(t.id as Parameters<typeof realClearInterval>[0]);
  }
  liveTimers.clear();
});

function statsExecResponse(buckets: Array<{ ts: string; executions: number }>, total: number) {
  return {
    bucket: "day",
    tz: "UTC",
    from: "2023-11-14T00:00:00.000Z",
    to: "2024-11-14T00:00:00.000Z",
    groups: buckets.length
      ? [
          {
            key: {},
            buckets: buckets.map((b) => ({ ts: b.ts, executions: b.executions })),
            totals: { executions: { count: total, by_status: {} } },
          },
        ]
      : [],
    totals: { executions: { count: total, by_status: {} } },
  };
}

function makeClient(
  buckets: Array<{ ts: string; executions: number }>,
  total: number,
): EngineClient {
  return {
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
    listMcpTools: mock(async () => ({ items: [] })),
    listMcpPrompts: mock(async () => ({ items: [] })),
    listMcpResources: mock(async () => ({ items: [] })),
    statsExecutions: mock(async () => statsExecResponse(buckets, total)),
  } as unknown as EngineClient;
}

const NO_FIELDS: FormField[] = [];

describe("StatusTab — embedded ActivityHeatmap", () => {
  test("renders the heatmap header and totals from /v1/stats/executions", async () => {
    const client = makeClient([{ ts: "2024-11-14T00:00:00.000Z", executions: 12 }], 12);
    const ui = renderInk(
      <StatusTab client={client} fields={NO_FIELDS} pendingRestartKeys={[]} overrideKeys={[]} />,
    );
    try {
      await ui.waitFor((t) => t.includes("Runtime status"));
      await ui.waitFor((t) => t.includes("Activity"));
      await ui.waitFor((t) => /totals: 12 runs/.test(t));
      expect(ui.text()).toContain("Last 30 days");
    } finally {
      ui.unmount();
    }
  });

  test("`1` switches the heatmap window to Last 7 days", async () => {
    const ui = renderInk(
      <StatusTab
        client={makeClient([], 0)}
        fields={NO_FIELDS}
        pendingRestartKeys={[]}
        overrideKeys={[]}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("Activity"));
      await ui.type("1");
      await ui.waitFor((t) => t.includes("current: Last 7 days"));
      expect(ui.text()).toContain("Last 7 days");
    } finally {
      ui.unmount();
    }
  });

  test("renders peak glyph when runs land on today", async () => {
    // allow-wall-clock: this test exercises a date-window UI that
    // intrinsically depends on the real wall-clock — the same exception
    // pattern `text-prompt.test.tsx` uses.
    const todayIso = new Date().toISOString();
    const ui = renderInk(
      <StatusTab
        client={makeClient([{ ts: todayIso, executions: 50 }], 50)}
        fields={NO_FIELDS}
        pendingRestartKeys={[]}
        overrideKeys={[]}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("Activity"));
      await ui.waitFor((t) => /totals: 50 runs/.test(t));
      expect(ui.text()).toContain("█");
    } finally {
      ui.unmount();
    }
  });

  test("`3` switches the heatmap window to All time", async () => {
    const ui = renderInk(
      <StatusTab
        client={makeClient([], 0)}
        fields={NO_FIELDS}
        pendingRestartKeys={[]}
        overrideKeys={[]}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("Activity"));
      await ui.type("3");
      await ui.waitFor((t) => t.includes("current: All time"));
      expect(ui.text()).toContain("All time");
    } finally {
      ui.unmount();
    }
  });
});
