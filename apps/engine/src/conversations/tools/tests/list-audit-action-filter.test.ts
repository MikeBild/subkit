// Unit: the `list_audit` tool exposes a singular `action` arg but the
// server-side AuditQueryFilters keys the filter as `actions: string[]`
// (consumed via inArray in audit/query.ts). The tool must MAP the singular
// arg onto `filters.actions = [action]` — not set a singular `action` key
// that the query layer silently ignores.
//
// Regression: the tool previously built `Record<string,string>` + `as any`
// and set `filters.action`, so the filter never reached `inArray` and the
// audit query returned UNFILTERED rows. The fix drops the cast (the type
// system now blocks an `action` key) and maps to `actions`.

import { describe, expect, test } from "bun:test";

import type { AuditQueryFilters } from "../../../audit/index.ts";
import { queryAuditTool } from "../generated/audit.ts";
import type { ToolContext } from "../index.ts";

type RecordedFilters = Partial<Omit<AuditQueryFilters, "tenant_id">>;

function makeCtx(): { ctx: ToolContext; recorded: RecordedFilters[] } {
  const recorded: RecordedFilters[] = [];
  const ctx = {
    engineClient: {
      audit: {
        query: async (filters: RecordedFilters) => {
          recorded.push(filters);
          return { items: [], next_cursor: null };
        },
      },
    },
  } as unknown as ToolContext;
  return { ctx, recorded };
}

describe("list_audit action filter", () => {
  test("maps singular `action` arg to `actions` array; no singular key", async () => {
    const { ctx, recorded } = makeCtx();

    const res = await queryAuditTool.execute(ctx, { action: "connector.invoked" });

    expect(res.ok).toBe(true);
    expect(recorded).toHaveLength(1);
    const filters = recorded[0] as Record<string, unknown>;
    expect(filters.actions).toEqual(["connector.invoked"]);
    expect("action" in filters).toBe(false);
  });

  test("passes resource_type and resource_id through unchanged", async () => {
    const { ctx, recorded } = makeCtx();

    await queryAuditTool.execute(ctx, {
      resource_type: "workflow",
      resource_id: "wf-123",
      action: "workflow.executed",
    });

    const filters = recorded[0] as Record<string, unknown>;
    expect(filters.resource_type).toBe("workflow");
    expect(filters.resource_id).toBe("wf-123");
    expect(filters.actions).toEqual(["workflow.executed"]);
  });

  test("omits the actions filter entirely when no action arg is given", async () => {
    const { ctx, recorded } = makeCtx();

    await queryAuditTool.execute(ctx, { resource_type: "workflow" });

    const filters = recorded[0] as Record<string, unknown>;
    expect("actions" in filters).toBe(false);
    expect("action" in filters).toBe(false);
    expect(filters.resource_type).toBe("workflow");
  });
});
