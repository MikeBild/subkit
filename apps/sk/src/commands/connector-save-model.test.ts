import { describe, expect, test } from "bun:test";
import { connectorCheckPlan } from "./connector-save-model.ts";

describe("connectorCheckPlan", () => {
  test("retains the command's validation and probe matrix", () => {
    expect(connectorCheckPlan("create", "http", false)).toBe("probe_draft");
    expect(connectorCheckPlan("create", "mcp", false)).toBe("defer_mcp_probe");
    expect(connectorCheckPlan("patch", "mcp", false)).toBe("validate_only");
    expect(connectorCheckPlan("create", "mcp", true)).toBe("skip");
    expect(connectorCheckPlan("patch", "http", true)).toBe("skip");
  });
});
