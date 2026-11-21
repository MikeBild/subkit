import { describe, expect, it } from "bun:test";
import { decideToolMode, resolveToolMode } from "../tool-policies.ts";

const DOP_TOKEN = "dop_v1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig";
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

  it("the inline-credential safeguard always asks", () => {
    expect(
      resolveToolMode({
        tool: "update_connector_draft",
        category: "draft_write",
        input: { config: { token: DOP_TOKEN } },
        overrides: {},
      }),
    ).toBe("confirm_before_execution");
  });

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
  });
});
