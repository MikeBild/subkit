// Verifies the activity heatmap is embedded inside the Status tab
// (formerly a standalone Stats tab). Also checks the 1/2/3 window
// toggles still work after the merge.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { EngineClient } from "../../engine-client.ts";
import { renderInk } from "../../tests/helpers/ink.tsx";
import type { FormField } from "../lib/zod-to-form-fields.ts";
import { StatusTab } from "../tabs/StatusTab.tsx";

// Quiet the 5s MCP polling timer (it would survive past unmount in
// test runners that lack a microtask flush around setInterval cleanup).
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

function makeClient(auditItems: Array<{ ts: string }>): EngineClient {
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
    tailAuditLog: mock(async () => ({ items: auditItems })),
  } as unknown as EngineClient;
}

const NO_FIELDS: FormField[] = [];

describe("StatusTab — embedded ActivityHeatmap", () => {
  test("renders the heatmap header and totals from audit log", async () => {
    const today = "2024-11-14T22:13:20.000Z";
    const items = Array.from({ length: 12 }, () => ({ ts: today }));
    const ui = renderInk(
      <StatusTab
        client={makeClient(items)}
        fields={NO_FIELDS}
        pendingRestartKeys={[]}
        overrideKeys={[]}
      />,
    );
    try {
      // Status content renders synchronously; heatmap content arrives
      // after the tailAuditLog promise resolves.
      await ui.waitFor((t) => t.includes("Runtime status"));
      await ui.waitFor((t) => t.includes("Activity"));
      await ui.waitFor((t) => /totals: 12 actions/.test(t));
      expect(ui.text()).toContain("Last 30 days");
    } finally {
      ui.unmount();
    }
  });

  test("`1` switches the heatmap window to Last 7 days", async () => {
    const ui = renderInk(
      <StatusTab
        client={makeClient([])}
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

  test("renders peak glyph when audit rows land on today (regression: ts vs created_at)", async () => {
    // Stamp the 50 audit rows with "right now" so they bucket into
    // today's cell in the heatmap. The heatmap renders the last 30
    // days anchored at `new Date()`; using a fixed past timestamp
    // would land outside that window and the peak glyph would
    // (correctly) not render.
    // allow-wall-clock: this test exercises a date-window UI that
    // intrinsically depends on the real wall-clock — the same
    // exception pattern `text-prompt.test.tsx` uses.
    const todayIso = new Date().toISOString();
    const items = Array.from({ length: 50 }, () => ({ ts: todayIso }));
    const ui = renderInk(
      <StatusTab
        client={makeClient(items)}
        fields={NO_FIELDS}
        pendingRestartKeys={[]}
        overrideKeys={[]}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("Activity"));
      await ui.waitFor((t) => /totals: 50 actions/.test(t));
      // The grid MUST contain the peak glyph somewhere — previously it
      // never did because `bucketize` read `created_at` while the
      // engine returns `ts`, so all 50 rows were silently dropped.
      expect(ui.text()).toContain("█");
    } finally {
      ui.unmount();
    }
  });

  test("`3` switches the heatmap window to All time", async () => {
    const ui = renderInk(
      <StatusTab
        client={makeClient([])}
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
