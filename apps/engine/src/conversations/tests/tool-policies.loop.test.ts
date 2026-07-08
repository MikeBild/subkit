// Loop integration test for the canonical tool-policies resolver.
//
// Locks the contract that the enforcement resolver — the ONE table the
// confirm gate reads — returns `confirm_before_execution` whenever a tool's
// DECLARED credential slots are filled, and does NOT gate on the shape of
// undeclared strings. This is the policy decision the loop's structured
// `tool_policy.resolved` log records and the `tool_policy.confirmation_required`
// audit row reproduces before sdk-wrap pauses the dispatch.

import { describe, expect, it } from "bun:test";
import { decideToolMode, resolveToolMode } from "../tool-policies.ts";

const DOP_TOKEN = "dop_v1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig";
// A legitimate base64 literal inside a transform. The log scrubber's
// high-entropy pattern matches it; the enforcement resolver must not.
const BASE64_LITERAL = "aHR0cHM6Ly9leGFtcGxlLmNvbS9hcGkvdjEvcmVzb3VyY2VzP3BhZ2U9MQ==";

describe("tool-policies.ts × loop pre-dispatch hook", () => {
  it("update_connector_draft with a declared credential field confirms", () => {
    expect(
      resolveToolMode({
        tool: "update_connector_draft",
        category: "draft_write",
        input: { config: { token: DOP_TOKEN } },
        overrides: {},
      }),
    ).toBe("confirm_before_execution");
  });

  it("names the rule that gated it, so the audit row cannot mis-report", () => {
    expect(
      decideToolMode({
        tool: "update_connector_draft",
        category: "draft_write",
        input: { config: { token: DOP_TOKEN } },
        overrides: {},
      }),
    ).toEqual({ mode: "confirm_before_execution", rule: "inline_credential" });
  });

  it("update_connector_draft without a credential field resolves to no_confirm", () => {
    expect(
      resolveToolMode({
        tool: "update_connector_draft",
        category: "draft_write",
        input: { name: "Acme renamed" },
        overrides: {},
      }),
    ).toBe("no_confirm");
  });

  it("the inline-credential safeguard outranks permission_mode=yolo", () => {
    expect(
      resolveToolMode({
        tool: "update_connector_draft",
        category: "draft_write",
        input: { config: { token: DOP_TOKEN } },
        overrides: {},
        permission_mode: "yolo",
      }),
    ).toBe("confirm_before_execution");
  });

  // The resolver is an AUTHORIZATION table, not a redaction one. Shape-matching
  // every string against the scrubber's catalog gated tools by what their
  // arguments LOOKED like rather than by what the call does — pausing
  // `no_confirm` reads on every iteration of an authoring session, above the
  // yolo short-circuit that is supposed to clear them. Secrets stay out of the
  // transcript via the masked form, the MCP secret-in-chat guard, and the
  // persist-time scrub.
  describe("undeclared secret-shaped input does not gate", () => {
    it("a token-shaped value in a tenant_read tool's payload stays no_confirm", () => {
      expect(
        resolveToolMode({
          tool: "search_knowledge",
          category: "tenant_read",
          input: { query: `use ${DOP_TOKEN} to authenticate` },
          overrides: {},
        }),
      ).toBe("no_confirm");
    });

    it("a base64 literal inside a transform stays no_confirm", () => {
      expect(
        resolveToolMode({
          tool: "dry_run_transform",
          category: "tenant_read",
          input: { code: `return atob('${BASE64_LITERAL}');` },
          overrides: {},
        }),
      ).toBe("no_confirm");
    });

    it("a JWT under an undeclared header key stays no_confirm", () => {
      expect(
        resolveToolMode({
          tool: "edit_workflow_patch",
          category: "draft_write",
          input: { steps: [{ headers: { authorization: JWT } }] },
          overrides: {},
        }),
      ).toBe("no_confirm");
    });

    it("permission_mode=yolo clears a token-shaped read", () => {
      expect(
        resolveToolMode({
          tool: "dry_run_transform",
          category: "tenant_read",
          input: { code: `return atob('${BASE64_LITERAL}');` },
          overrides: {},
          permission_mode: "yolo",
        }),
      ).toBe("no_confirm");
    });
  });
});
