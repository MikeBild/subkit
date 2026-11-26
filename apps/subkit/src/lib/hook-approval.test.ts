import { describe, expect, test } from "bun:test";
import type { EngineClient } from "../engine-client.ts";
import { hookApprovalNotice, hookApprovalNoticeFor } from "./hook-approval.ts";

type StatusClient = Pick<EngineClient, "base" | "getWorkflowAutomationStatus">;

const hook = (id: string, ready: boolean) => ({
  inbound_hook_id: id,
  workflow_id: "wf 1",
  slug: id,
  state: ready ? ("authorized" as const) : ("approval_required" as const),
  ready,
  environment: "prod" as const,
  admission_hold: null,
  last_refused_at: null,
  last_refused_reason: null,
});

type Reply = ReturnType<typeof hook>[] | Error | "malformed";

const client = (hooks: Reply): StatusClient => ({
  base: "https://engine.example.test/base/",
  getWorkflowAutomationStatus: async () => {
    if (hooks instanceof Error) throw hooks;
    if (hooks === "malformed")
      return {} as Awaited<ReturnType<StatusClient["getWorkflowAutomationStatus"]>>;
    return { schedules: [], inbound_hooks: hooks };
  },
});

describe("hook approval notice", () => {
  test("the notice links the workflow in Cockpit and names the 202 hold", () => {
    const notice = hookApprovalNotice(client([]), "wf 1");
    expect(notice).toContain("https://engine.example.test/base/cockpit/workflows/wf%201");
    expect(notice).toContain("answered 202");
  });

  const cases: Array<[string, Reply, string | undefined, boolean]> = [
    ["status unavailable", new Error("offline"), "h1", true],
    ["status without hooks", "malformed", "h1", true],
    ["hook held", [hook("h1", false)], "h1", true],
    ["hook ready", [hook("h1", true)], "h1", false],
    ["hook missing from status", [hook("h2", true)], "h1", true],
    ["workflow without hooks", [], undefined, false],
    ["one of the workflow hooks held", [hook("h1", true), hook("h2", false)], undefined, true],
    ["all workflow hooks ready", [hook("h1", true)], undefined, false],
  ];
  test.each(cases)("%s", async (_label, hooks, hookId, shown) => {
    const notice = await hookApprovalNoticeFor(client(hooks), "wf 1", hookId);
    expect(notice.length > 0).toBe(shown);
  });
});
