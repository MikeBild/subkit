import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { notificationRules } from "../../db/schema/notifications.ts";
import { matchGlob, matchRules, severityMeets } from "../matcher.ts";
import { createNotificationCtx, type NotificationTestCtx } from "./setup.ts";

let ctx: NotificationTestCtx;
beforeAll(async () => {
  ctx = await createNotificationCtx("matcher");
});
afterAll(async () => {
  await ctx.cleanup();
});

describe("notifications: matcher helpers", () => {
  test("matchGlob honors wildcard / prefix / exact", () => {
    expect(matchGlob("*", "anything")).toBe(true);
    expect(matchGlob("execution.*", "execution.failed")).toBe(true);
    expect(matchGlob("execution.*", "workflow.updated")).toBe(false);
    expect(matchGlob("execution.failed", "execution.failed")).toBe(true);
    expect(matchGlob("execution.failed", "execution.succeeded")).toBe(false);
    expect(matchGlob("a.*,b.c", "a.zoo")).toBe(true);
    expect(matchGlob("a.*,b.c", "b.c")).toBe(true);
    expect(matchGlob("a.*,b.c", "c.d")).toBe(false);
  });

  test("severityMeets enforces the severity ladder", () => {
    expect(severityMeets("error", "warn")).toBe(true);
    expect(severityMeets("warn", "error")).toBe(false);
    expect(severityMeets("critical", "info")).toBe(true);
    expect(severityMeets("debug", "debug")).toBe(true);
    expect(severityMeets(undefined, "info")).toBe(true);
    expect(severityMeets(undefined, "error")).toBe(false);
  });
});

describe("notifications: matchRules", () => {
  test("returns every rule whose filters accept the event", async () => {
    await ctx.db.insert(notificationRules).values([
      {
        tenant_id: ctx.tenant_id,
        name: "exec-errors-any-workflow",
        event_pattern: "execution.*",
        workflow_pattern: "*",
        severity: "error",
        request_source_filter: null,
        target_workspace_id: "W1",
        target_channel_id: "C_ONCALL",
      },
      {
        tenant_id: ctx.tenant_id,
        name: "api-exec-failed-exact",
        event_pattern: "execution.failed",
        workflow_pattern: "*",
        severity: "warn",
        request_source_filter: ["api", "chat"],
        target_workspace_id: "W1",
        target_channel_id: "C_API",
      },
      {
        tenant_id: ctx.tenant_id,
        name: "workflow-updates-info",
        event_pattern: "workflow.updated",
        workflow_pattern: "*",
        severity: "info",
        request_source_filter: null,
        target_workspace_id: "W1",
        target_channel_id: "C_IGNORED",
      },
      {
        tenant_id: ctx.tenant_id,
        name: "exec-critical-only",
        event_pattern: "execution.*",
        workflow_pattern: "*",
        severity: "critical",
        request_source_filter: null,
        target_workspace_id: "W1",
        target_channel_id: "C_PAGER",
      },
    ]);

    const matched = await matchRules(ctx.db, ctx.tenant_id, {
      tenant_id: ctx.tenant_id,
      type: "execution.failed",
      severity: "error",
      request_source: "api",
      payload: null,
    });

    const names = matched.map((m) => m.row.name).sort();
    expect(names).toEqual(["api-exec-failed-exact", "exec-errors-any-workflow"]);
  });

  test("workflow_pattern and request_source_filter narrow the match", async () => {
    await ctx.db.insert(notificationRules).values({
      tenant_id: ctx.tenant_id,
      name: "mcp-only-one-wf",
      event_pattern: "execution.*",
      workflow_pattern: "00000000-0000-0000-0000-00000000aaaa",
      severity: "info",
      request_source_filter: ["mcp"],
      target_workspace_id: "W1",
      target_channel_id: "C_MCP",
    });

    const wrongWorkflow = await matchRules(ctx.db, ctx.tenant_id, {
      tenant_id: ctx.tenant_id,
      type: "execution.succeeded",
      workflow_id: "00000000-0000-0000-0000-00000000bbbb",
      severity: "info",
      request_source: "mcp",
    });
    expect(wrongWorkflow.every((m) => m.row.name !== "mcp-only-one-wf")).toBe(true);

    const wrongSource = await matchRules(ctx.db, ctx.tenant_id, {
      tenant_id: ctx.tenant_id,
      type: "execution.succeeded",
      workflow_id: "00000000-0000-0000-0000-00000000aaaa",
      severity: "info",
      request_source: "api",
    });
    expect(wrongSource.every((m) => m.row.name !== "mcp-only-one-wf")).toBe(true);

    const hit = await matchRules(ctx.db, ctx.tenant_id, {
      tenant_id: ctx.tenant_id,
      type: "execution.succeeded",
      workflow_id: "00000000-0000-0000-0000-00000000aaaa",
      severity: "info",
      request_source: "mcp",
    });
    expect(hit.some((m) => m.row.name === "mcp-only-one-wf")).toBe(true);
  });
});
