import { describe, expect, test } from "bun:test";
import type { Db } from "../../../db/client.ts";
import { formatKeysetCursor } from "../../../db/keyset-cursor.ts";
import { queryAuditTool } from "../engine-api/audit.ts";
import { listExecutionsTool } from "../engine-api/executions.ts";
import type { ConversationTool, ToolContext } from "../index.ts";
import { wrapOne } from "../sdk-wrap/invoke.ts";
import type { TurnSignals } from "../sdk-wrap/state.ts";

const workflowId = "11111111-1111-4111-8111-111111111111";
const nextCursor = formatKeysetCursor({
  ts: "2026-01-01T12:00:00.123456Z",
  id: "22222222-2222-4222-8222-222222222222",
});

function definitionFor(tool: ConversationTool) {
  return wrapOne(tool, {} as ToolContext, {} as TurnSignals, [], {} as Db, {});
}

for (const tool of [listExecutionsTool, queryAuditTool]) {
  describe(`${tool.name} pagination boundary`, () => {
    test("preserves explicit non-strict generation so optional filters stay optional", () => {
      expect(definitionFor(tool).strict).toBe(false);
    });

    test("a scoped first page needs no cursor or invented filters", () => {
      expect(tool.inputSchema.parse({ workflow_id: workflowId })).toEqual({
        workflow_id: workflowId,
      });
    });

    test("preserves a returned keyset cursor and its scope for the next page", () => {
      const input = { workflow_id: workflowId, limit: 10, cursor: nextCursor };
      expect(tool.inputSchema.parse(input)).toEqual(input);
    });

    test("rejects the observed invented cursors with actionable recovery guidance", () => {
      for (const cursor of ["all", "none", "0", "connector-readiness"]) {
        const parsed = tool.inputSchema.safeParse({ workflow_id: workflowId, cursor });
        expect(parsed.success).toBe(false);
        if (parsed.success) throw new Error("Expected the invented cursor to be rejected");
        const issue = parsed.error.issues.find((entry) => entry.path[0] === "cursor");
        expect(issue?.message).toContain("Omit cursor for the first page");
        expect(issue?.message).toContain("next_cursor");
        expect(issue?.message).toContain("same filters");
      }
    });
  });
}

test("the adapter preserves explicit strict mode and leaves unspecified tools unchanged", () => {
  expect(definitionFor({ ...listExecutionsTool, strict: true }).strict).toBe(true);
  const { strict: _strict, ...unspecified } = listExecutionsTool;
  expect(Object.hasOwn(definitionFor(unspecified), "strict")).toBe(false);
});

test("audit keeps accepting its existing timestamp-only cursor contract", () => {
  expect(queryAuditTool.inputSchema.parse({ cursor: "2026-01-01T12:00:00Z" })).toEqual({
    cursor: "2026-01-01T12:00:00Z",
  });
  expect(listExecutionsTool.inputSchema.safeParse({ cursor: "2026-01-01T12:00:00Z" }).success).toBe(
    false,
  );
});
