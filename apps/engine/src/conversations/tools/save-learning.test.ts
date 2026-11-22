import { describe, expect, test } from "bun:test";
import type { Db } from "../../db/client.ts";
import type { ToolContext } from "./index.ts";
import { learningClient, saveLearningTool } from "./save-learning.ts";

const untouchableDb = new Proxy(
  {},
  {
    get() {
      throw new Error("the database must not be touched");
    },
  },
) as Db;

function ctx(): ToolContext {
  return {
    db: untouchableDb,
    tenant_id: "00000000-0000-4000-8000-000000000001",
    conversation_id: "00000000-0000-4000-8000-000000000002",
    actor_id: null,
    principal: null,
    connector_id: null,
    workflow_id: null,
  } as unknown as ToolContext;
}

describe("save_learning sensitive paths", () => {
  test("a learning naming a key file location is refused without persisting", async () => {
    const result = await saveLearningTool.execute(ctx(), {
      kind: "fact",
      title: "Engine master key",
      body: "The master key lives at /etc/subkit/master.key on the host.",
      domains: ["infra"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error_code).toBe("sensitive_path");
    expect(result.data).toEqual({ outcome: "dropped", intake_item_id: null, kind: "fact" });
  });
});

describe("save_learning assistant", () => {
  test("names the MCP client, Cockpit chat or the subkit CLI", () => {
    expect(learningClient({ surface: "mcp", mcp_client_name: "  claude-code " })).toBe(
      "claude-code",
    );
    expect(learningClient({ surface: "mcp", mcp_client_name: "codex-mcp-client" })).toBe(
      "codex-mcp-client",
    );
    expect(learningClient({ surface: "mcp" })).toBeUndefined();
    expect(learningClient({ surface: "mcp", mcp_client_name: " " })).toBeUndefined();
    expect(learningClient({ surface: "mcp", mcp_client_name: "x".repeat(200) })).toHaveLength(80);
    expect(learningClient({ surface: "web" })).toBe("chat");
    expect(learningClient({})).toBe("chat");
    expect(learningClient({ surface: "sk_interactive" })).toBe("subkit");
    expect(learningClient({ surface: "sk_headless" })).toBe("subkit");
  });
});
