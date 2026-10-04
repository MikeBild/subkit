import { describe, expect, test } from "bun:test";
import { ThemeProvider } from "@chat-ui/index.ts";
import { type RunSummary, RunsTable } from "../domain/workflows/RunsTable.tsx";
import { flush, renderInk } from "./helpers/ink.tsx";

const RUNS: RunSummary[] = [
  {
    id: "r1",
    workflow_name: "ingest_users",
    status: "succeeded",
    started_at: "2026-05-01T00:00:00Z",
    duration_ms: 1200,
  },
  {
    id: "r2",
    workflow_name: "rotate_keys",
    status: "failed",
    started_at: "2026-05-01T01:00:00Z",
    duration_ms: 300,
  },
  {
    id: "r3",
    workflow_name: "ingest_users",
    status: "running",
    started_at: "2026-05-01T02:00:00Z",
  },
];

describe("<RunsTable>", () => {
  test("renders all rows by default", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <RunsTable runs={RUNS} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("ingest_users");
      expect(text).toContain("rotate_keys");
      expect(text).toContain("ok");
      expect(text).toContain("3 match");
    } finally {
      ui.unmount();
    }
  });

  test("status filter narrows the list", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <RunsTable runs={RUNS} filter={{ status: ["failed"] }} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("rotate_keys");
      expect(text).not.toContain("ingest_users");
      expect(text).toContain("1 match");
    } finally {
      ui.unmount();
    }
  });

  test("Enter calls onSelect with the highlighted run", async () => {
    let selected: RunSummary | null = null;
    const ui = renderInk(
      <ThemeProvider>
        <RunsTable
          runs={RUNS}
          onSelect={(r) => {
            selected = r;
          }}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      await ui.press("enter");
      await flush();
      expect(selected).not.toBeNull();
      expect((selected as RunSummary | null)?.id).toBe("r1");
    } finally {
      ui.unmount();
    }
  });

  test("`f` cycles status filter", async () => {
    let currentFilter: { status?: string[] } | null = null;
    const ui = renderInk(
      <ThemeProvider>
        <RunsTable
          runs={RUNS}
          onFilterChange={(f) => {
            currentFilter = f;
          }}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      await ui.type("f");
      await flush();
      expect(currentFilter).not.toBeNull();
      expect(Array.isArray((currentFilter as { status?: string[] } | null)?.status)).toBe(true);
    } finally {
      ui.unmount();
    }
  });

  test("empty filter renders helpful copy", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <RunsTable runs={[]} />
      </ThemeProvider>,
    );
    try {
      await flush();
      expect(ui.text()).toContain("no runs match");
    } finally {
      ui.unmount();
    }
  });
});
