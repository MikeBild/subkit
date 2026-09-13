// Ink-component coverage for BackgroundToolGroup + the isBackgroundTool
// classifier.

import type { ToolCallState } from "@cli-core/index.ts";
import { describe, expect, test } from "bun:test";

import { BackgroundToolGroup, isBackgroundTool } from "../repl/background-tools.tsx";
import { renderInk } from "./helpers/ink.tsx";

function call(name: string, status: ToolCallState["status"] = "done"): ToolCallState {
  return { id: `c-${name}-${status}`, name, args: {}, status };
}

describe("isBackgroundTool", () => {
  test("matches explicit background names", () => {
    expect(isBackgroundTool(call("list_workflows"))).toBe(true);
    expect(isBackgroundTool(call("web_search"))).toBe(true);
    expect(isBackgroundTool(call("load_skill"))).toBe(true);
    expect(isBackgroundTool(call("search_docs"))).toBe(true);
  });

  test("matches prefix families", () => {
    expect(isBackgroundTool(call("list_anything_new"))).toBe(true);
    expect(isBackgroundTool(call("search_whatever"))).toBe(true);
    expect(isBackgroundTool(call("read_docs"))).toBe(true);
  });

  test("failed tools are never classified as background", () => {
    expect(isBackgroundTool(call("list_workflows", "failed"))).toBe(false);
  });

  test("unrelated tool names are not background", () => {
    expect(isBackgroundTool(call("save_workflow_draft"))).toBe(false);
    expect(isBackgroundTool(call("dry_run_step"))).toBe(false);
  });
});

describe("BackgroundToolGroup (component)", () => {
  test("empty calls renders nothing", () => {
    const ui = renderInk(<BackgroundToolGroup calls={[]} logs={[]} detailed={false} />);
    try {
      expect(ui.text().trim()).toBe("");
    } finally {
      ui.unmount();
    }
  });

  test("all calls complete — renders 'background actions' + total", async () => {
    const calls = [call("list_workflows"), call("search_docs")];
    const ui = renderInk(<BackgroundToolGroup calls={calls} logs={[]} detailed={false} />);
    try {
      await ui.waitFor((t) => t.includes("background actions"));
      const txt = ui.text();
      expect(txt).toContain("background actions");
      expect(txt).not.toContain("running");
      expect(txt).toContain("2 total");
      expect(txt).toContain("read documentation");
    } finally {
      ui.unmount();
    }
  });

  test("active calls surface 'running' + active count", async () => {
    const calls = [call("list_workflows", "running"), call("search_knowledge", "done")];
    const ui = renderInk(<BackgroundToolGroup calls={calls} logs={[]} detailed={false} />);
    try {
      await ui.waitFor((t) => t.includes("running"));
      const txt = ui.text();
      expect(txt).toContain("background actions running");
      expect(txt).toContain("1 active");
    } finally {
      ui.unmount();
    }
  });

  test("detailed=true lists every call", async () => {
    const calls = [call("list_workflows"), call("search_knowledge")];
    const ui = renderInk(<BackgroundToolGroup calls={calls} logs={[]} detailed={true} />);
    try {
      await ui.waitFor((t) => t.includes("list workflows"));
      const txt = ui.text();
      expect(txt).toContain("list workflows");
      expect(txt).toContain("search knowledge");
    } finally {
      ui.unmount();
    }
  });

  test("logs render under the group", async () => {
    const calls = [call("list_workflows")];
    const logs = [
      {
        call_id: "c-list_workflows-done",
        tool: "list_workflows",
        level: "info" as const,
        message: "found 3 rows",
        ts: "2026-04-20T00:00:00.000Z",
      },
    ];
    const ui = renderInk(<BackgroundToolGroup calls={calls} logs={logs} detailed={false} />);
    try {
      await ui.waitFor((t) => t.includes("found 3 rows"));
      expect(ui.text()).toContain("[info]");
    } finally {
      ui.unmount();
    }
  });
});
