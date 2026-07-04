// Unit tests for the MCP adapter's envelope rendering.
//
// Focus: a `needs_confirm` result must be LEGIBLE to a text-only client (one
// that does not parse `_meta`, e.g. ChatGPT) — it must read as an actionable
// "re-call confirm_tool_call" state, not a tool refusal/decline. Regressing
// this is the ChatGPT confirm-loop failure.

import { describe, expect, test } from "bun:test";
import type { ConfirmEnvelope, ToolEnvelope } from "../tools/types.ts";
import { envelopeToMcpResponse } from "./adapter.ts";

const confirm: ConfirmEnvelope = {
  tool: "call_connector",
  args: { connector_id: "c1", method: "DELETE" },
  policy_mode: "confirm_before_execution",
  reason: "destructive_action",
  tool_call_id: "tc-123",
  resume: "Approve the delete to continue.",
};

describe("envelopeToMcpResponse — needs_confirm legibility", () => {
  const envelope: ToolEnvelope = { status: "needs_confirm", confirm };
  const res = envelopeToMcpResponse(envelope);
  const text = res.content[0]?.text ?? "";
  const parsed = JSON.parse(text) as Record<string, unknown>;

  test("content stays a single valid JSON object (parseable by clients)", () => {
    // Must remain parseable — the confirm_tool_call fallback + tests JSON.parse it.
    expect(typeof parsed).toBe("object");
    expect(parsed.tool_call_id).toBe("tc-123");
    expect(parsed.tool).toBe("call_connector");
  });

  test("carries an explicit status + actionable instruction naming confirm_tool_call", () => {
    expect(parsed.status).toBe("needs_confirm");
    const instruction = String(parsed.instruction ?? "");
    expect(instruction).toContain("confirm_tool_call");
    expect(instruction).toContain("call_connector");
    expect(instruction).toContain("tc-123");
  });

  test("frames the pause as awaiting approval, NOT a refusal", () => {
    const instruction = String(parsed.instruction ?? "").toLowerCase();
    expect(instruction).toContain("not");
    expect(instruction).toMatch(/paused|approval/);
    // isError stays false: a paused approval is not a tool execution error.
    expect(res.isError).toBe(false);
  });

  test("still carries the structured envelope in _meta for parsing clients", () => {
    expect(res._meta?.subkit).toBeDefined();
  });
});
