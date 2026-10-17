import { describe, expect, test } from "bun:test";
import type { Db } from "../../db/client.ts";
import type { ToolContext } from "./index.ts";
import { saveLearningTool } from "./save-learning.ts";

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
    expect(result.data).toEqual({ action: "dropped", candidate_id: null, kind: "fact" });
  });
});
