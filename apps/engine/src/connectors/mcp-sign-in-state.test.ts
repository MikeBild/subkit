import { describe, expect, test } from "bun:test";
import {
  connectorSignsInInteractively,
  MCP_SIGN_IN_PENDING_REASON,
  type McpSignInEvent,
  type McpSignInState,
  mcpSignInStartSteps,
  mcpSignInTransition,
} from "./mcp-sign-in-state.ts";

const started = (client_known: boolean): McpSignInEvent => ({
  type: "sign_in_started",
  client_known,
});

const allowed: ReadonlyArray<[McpSignInState, McpSignInEvent, McpSignInState]> = [
  ["needs_sign_in", started(false), "registering"],
  ["needs_sign_in", started(true), "awaiting_consent"],
  ["registering", { type: "client_registered" }, "awaiting_consent"],
  ["registering", { type: "sign_in_failed" }, "failed"],
  ["awaiting_consent", { type: "consent_granted" }, "connected"],
  ["awaiting_consent", { type: "sign_in_failed" }, "failed"],
  ["awaiting_consent", started(true), "awaiting_consent"],
  ["failed", started(true), "awaiting_consent"],
  ["failed", started(false), "registering"],
  ["failed", { type: "sign_in_reset" }, "needs_sign_in"],
  ["connected", started(true), "awaiting_consent"],
  ["connected", { type: "sign_in_reset" }, "needs_sign_in"],
];

const refused: ReadonlyArray<[McpSignInState, McpSignInEvent]> = [
  ["needs_sign_in", { type: "consent_granted" }],
  ["needs_sign_in", { type: "client_registered" }],
  ["registering", { type: "consent_granted" }],
  ["registering", started(true)],
  ["awaiting_consent", { type: "client_registered" }],
  ["connected", { type: "consent_granted" }],
  ["connected", { type: "sign_in_failed" }],
  ["failed", { type: "consent_granted" }],
];

describe("mcpSignInTransition", () => {
  for (const [from, event, to] of allowed) {
    test(`${from} --${event.type}--> ${to}`, () => {
      expect(mcpSignInTransition(from, event)).toEqual({ ok: true, from, to, event: event.type });
    });
  }
  for (const [from, event] of refused) {
    test(`${from} refuses ${event.type}`, () => {
      expect(mcpSignInTransition(from, event)).toEqual({
        ok: false,
        from,
        event: event.type,
        reason: "transition_not_allowed",
      });
    });
  }
});

describe("mcpSignInStartSteps", () => {
  test("a first sign-in registers the client before asking for consent", () => {
    expect(mcpSignInStartSteps("needs_sign_in", { registered_client: true })).toEqual({
      ok: true,
      state: "awaiting_consent",
      path: ["needs_sign_in", "registering", "awaiting_consent"],
    });
  });
  test("a repeated sign-in reuses the stored client", () => {
    expect(mcpSignInStartSteps("failed", { registered_client: false })).toEqual({
      ok: true,
      state: "awaiting_consent",
      path: ["failed", "awaiting_consent"],
    });
  });
  test("a start while a registration is running is refused", () => {
    expect(mcpSignInStartSteps("registering", { registered_client: false })).toEqual({
      ok: false,
      state: "registering",
      path: ["registering"],
    });
  });
});

describe("connectorSignsInInteractively", () => {
  const cases: ReadonlyArray<[string, string | null, boolean]> = [
    ["mcp", "oauth2", true],
    ["mcp", "bearer", false],
    ["mcp", "oauth2_client", false],
    ["mcp", null, false],
    ["http", "oauth2", false],
  ];
  for (const [driver, auth_type, expected] of cases) {
    test(`${driver} + ${auth_type} → ${expected}`, () => {
      expect(connectorSignsInInteractively({ driver, auth_type })).toBe(expected);
    });
  }
  test("the pending reason names the sign-in", () => {
    expect(MCP_SIGN_IN_PENDING_REASON).toBe("sign_in_required");
  });
});
