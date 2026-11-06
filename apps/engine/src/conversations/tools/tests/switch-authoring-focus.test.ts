import { describe, expect, test } from "bun:test";
import {
  refreshDraftSummary,
  withAuthoringFocus,
  withConnectorDraft,
  withWorkflowDraft,
} from "../../authoring-state/index.ts";
import type { ConnectorDraftDocument, DraftDocument } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { switchAuthoringFocusTool } from "../switch-authoring-focus.ts";

function workflowDraft(): DraftDocument {
  return withWorkflowDraft(refreshDraftSummary({ workflow: { name: "", steps: [] } }), {
    name: "Harmoniqs signups",
    slug: "harmoniqs-signups",
    steps: [{ id: "echo", kind: "transform", expression: "return 1;", language: "javascript" }],
  });
}

const CONNECTOR: ConnectorDraftDocument = {
  name: "Harmoniqs Supabase REST",
  slug: "harmoniqs-supabase-rest",
  driver: "http",
  environment: "prod",
} as ConnectorDraftDocument;

function stubCtx(draft: DraftDocument): ToolContext & { current: () => DraftDocument } {
  let live = draft;
  return {
    db: {} as ToolContext["db"],
    tenant_id: "00000000-0000-4000-8000-000000000001",
    conversation_id: "00000000-0000-4000-8000-000000000002",
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    permission_mode: null,
    // biome-ignore lint/suspicious/noExplicitAny: skills catalog stub
    engineClient: { skills: { list: async () => [] } } as any,
    getDraft: () => live,
    setDraft: async (next) => {
      live = next;
    },
    current: () => live,
  };
}

describe("switch_authoring_focus", () => {
  test("connector focus keeps the workflow draft and makes the connector the active target", async () => {
    const before = workflowDraft();
    expect(before.summary?.active_target.kind).toBe("workflow");
    const ctx = stubCtx(before);
    const result = await switchAuthoringFocusTool.execute(ctx, { focus: "connector" });
    expect(result.ok).toBe(true);
    const after = ctx.current();
    expect(after.workflow.steps).toHaveLength(1);
    expect(after.mode).toBe("connector_authoring");
    expect(after.summary?.active_target.kind).toBe("connector");
    expect(after.summary?.stage.startsWith("connector_")).toBe(true);

    const drafted = withConnectorDraft(after, CONNECTOR);
    expect(drafted.summary?.active_target.kind).toBe("connector");
    const saved = withConnectorDraft(drafted, { ...CONNECTOR, saved_connector_id: "c-1" });
    expect(saved.summary?.active_target.kind).toBe("workflow");
  });

  test("workflow focus refuses to drop an unsaved connector without consent", async () => {
    const withConnector = withConnectorDraft(
      withAuthoringFocus(workflowDraft(), "connector"),
      CONNECTOR,
    );
    const ctx = stubCtx(withConnector);
    const refused = await switchAuthoringFocusTool.execute(ctx, { focus: "workflow" });
    expect(refused.ok).toBe(false);
    expect(ctx.current().connector?.slug).toBe("harmoniqs-supabase-rest");

    const switched = await switchAuthoringFocusTool.execute(ctx, {
      focus: "workflow",
      discard_unsaved_connector: true,
    });
    expect(switched.ok).toBe(true);
    const after = ctx.current();
    expect(after.connector ?? null).toBeNull();
    expect(after.workflow.steps).toHaveLength(1);
    expect(after.mode).toBe("workflow_authoring");
    expect(after.summary?.active_target.kind).toBe("workflow");
    expect(after.state?.authoring_focus ?? null).toBeNull();
  });

  test("a connector-only conversation can switch to a fresh workflow", async () => {
    const connectorOnly = withConnectorDraft(
      refreshDraftSummary({ workflow: { name: "", steps: [] } }),
      CONNECTOR,
    );
    expect(connectorOnly.summary?.active_target.kind).toBe("connector");
    const ctx = stubCtx(connectorOnly);
    const result = await switchAuthoringFocusTool.execute(ctx, {
      focus: "workflow",
      discard_unsaved_connector: true,
    });
    expect(result.ok).toBe(true);
    expect(ctx.current().summary?.active_target.kind).toBe("none");
    expect(ctx.current().summary?.stage).toBe("idle");
  });
});
