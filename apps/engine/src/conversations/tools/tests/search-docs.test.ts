import { describe, expect, it } from "bun:test";
import { normalizeToolResultPayload } from "../result-payload.ts";
import { searchDocsTool } from "../search-docs.ts";

const MISSING_SCOPE =
  "connector_id is required — pass it explicitly or bind the conversation to a connector first";

describe("search_docs failure envelope", () => {
  it("a missing connector scope names the code, the message and the recovery tools", async () => {
    const result = await searchDocsTool.execute({ connector_id: null } as never, {
      query: "create customer",
    });

    expect(result.ok).toBe(false);
    expect(normalizeToolResultPayload(result)).toEqual({
      error: MISSING_SCOPE,
      error_code: "connector_scope_required",
      message: MISSING_SCOPE,
      next_best_actions: ["find_connector", "list_connectors"],
    });
  });
});
