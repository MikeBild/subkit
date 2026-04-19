import { describe, expect, test } from "bun:test";
import { initialSessionState } from "@cli-core/index.ts";
import type { ConversationContextSnapshot, EngineClient } from "../engine-client.ts";
import type { PaneSpec } from "../repl/slash-handler.ts";
import { handleSlash } from "../repl/slash-handler.ts";

function mkCtx(client: EngineClient, conversationId = "conv-1") {
  const session = initialSessionState(conversationId);
  const panes: PaneSpec[] = [];
  return {
    panes,
    ctx: {
      client,
      profile: {
        name: "test",
        engine_url: "http://x",
        api_key: "k",
        active_tenant_id: "tenant-1",
      },
      session,
      setConversationId: () => {},
      allowedPermissions: [] as readonly string[],
      openPane: (spec: PaneSpec) => {
        panes.push(spec);
      },
    },
  };
}

describe("authoring slash panes", () => {
  test("/draft opens a structured draft overview pane", async () => {
    const client = {
      getConversation: async () => ({
        conversation: {} as never,
        messages: [],
        tool_calls: [],
        draft: {
          mode: "connector_authoring",
          connector: {
            name: "Local API",
            driver: "http",
            environment: "dev",
            auth_type: "none",
            latest_probe: { summary: "Probe succeeded with HTTP 200." },
          },
          workflow: { name: "new-workflow", steps: [] },
          summary: {
            readiness: "ready_to_save",
            next_action: "Save the connector draft or continue editing it.",
            missing_fields: [],
            progress_label: "Connector draft",
          },
        },
      }),
    } as unknown as EngineClient;
    const { ctx, panes } = mkCtx(client);
    const result = await handleSlash("draft", [], ctx);
    expect(result).toBeNull();
    const pane = panes[0];
    expect(pane?.kind).toBe("text");
    expect((pane as { title: string }).title).toBe("draft overview");
    expect((pane as { lines: readonly string[] }).lines.join("\n")).toContain(
      "Probe succeeded with HTTP 200",
    );
  });

  test("/context opens the conversation context pane", async () => {
    const snapshot: ConversationContextSnapshot = {
      conversation_id: "conv-1",
      connector_id: null,
      workflow_id: null,
      draft_mode: "workflow_authoring",
      draft_summary: {
        readiness: "ready_to_probe",
        next_action: "Preview a step or the whole workflow before committing.",
        missing_fields: [],
        progress_label: "1 workflow step",
      },
      skills: {
        global: [{ id: "s1", title: "global skill" }],
        connector: [],
        workflow: [{ id: "s2", title: "workflow skill" }],
        total: 2,
      },
      messages: { total: 4, last_role: "assistant" },
      tool_calls_total: 3,
      pending_elicitations: 1,
    };
    const client = {
      getConversationContextSnapshot: async () => snapshot,
    } as unknown as EngineClient;
    const { ctx, panes } = mkCtx(client);
    const result = await handleSlash("context", [], ctx);
    expect(result).toBeNull();
    const pane = panes[0];
    expect(pane?.kind).toBe("text");
    expect((pane as { title: string }).title).toBe("conversation context");
    expect((pane as { lines: readonly string[] }).lines.join("\n")).toContain("workflow skill");
    expect((pane as { lines: readonly string[] }).lines.join("\n")).toContain(
      "Preview a step or the whole workflow",
    );
  });
});
