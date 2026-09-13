import { expect, test } from "bun:test";

import { rerunExecutionTool } from "../generated/writes/rerun-execution.ts";
import type { ToolContext } from "../index.ts";

test("rerun refuses a missing principal before reading or executing anything", async () => {
  const result = await rerunExecutionTool.execute(
    { tenant_id: "tenant", principal: null } as ToolContext,
    { execution_id: "unreached" },
  );
  expect(result).toMatchObject({ ok: false, data: { error: "principal_required" } });
});

test("rerun refuses a principal from a different tenant before any database access", async () => {
  const result = await rerunExecutionTool.execute(
    { tenant_id: "tenant", principal: { tenant_id: "other" } } as ToolContext,
    { execution_id: "unreached" },
  );
  expect(result).toMatchObject({ ok: false, data: { error: "permission_denied" } });
});
