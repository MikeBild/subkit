// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${…}` tokens are the subject under test — these are intentional unresolved-placeholder probes, not template-literal typos.

// Unit tests for the canonical tool execution-mode resolver.
//
// The resolver is the ONE place that decides whether a tool call must
// pause for human confirmation. These tests lock the policy table and
// each predicate so a refactor that loosens the gate fails CI.

import { describe, expect, it } from "bun:test";
import {
  confirmIfNonDevEnv,
  confirmIfSensitiveInput,
  confirmIfTouchesAuth,
  confirmIfUnresolvedPlaceholders,
  getToolPolicy,
  resolveExecutionMode,
  TOOL_POLICIES,
} from "./tool-policies.ts";

const CTX = { tenant_id: "ten_test" };

describe("predicate: confirmIfSensitiveInput", () => {
  it("flags a DigitalOcean PAT pasted into a config field", () => {
    expect(
      confirmIfSensitiveInput({
        config: { token: "dop_v1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF" },
      }),
    ).toBe("confirm_before_execution");
  });

  it("flags a GitHub PAT in a deeply nested field", () => {
    expect(
      confirmIfSensitiveInput({
        connector: {
          patch: { credential: { value: "ghp_abcdefghijklmnopqrstuvwxyz012345" } },
        },
      }),
    ).toBe("confirm_before_execution");
  });

  it("flags any non-empty string under a sensitive key name", () => {
    // No shape match, but the key name forces redaction.
    expect(
      confirmIfSensitiveInput({
        config: { client_secret: "not-a-known-shape-but-key-says-secret" },
      }),
    ).toBe("confirm_before_execution");
  });

  it("flags a JWT", () => {
    expect(
      confirmIfSensitiveInput({
        headers: { authorization: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature" },
      }),
    ).toBe("confirm_before_execution");
  });

  it("flags a Bearer header", () => {
    expect(confirmIfSensitiveInput({ headers: ["Bearer abc.123_xyz"] })).toBe(
      "confirm_before_execution",
    );
  });

  it("returns auto for an empty patch", () => {
    expect(confirmIfSensitiveInput({})).toBe("auto");
  });

  it("returns auto for ordinary text fields", () => {
    expect(
      confirmIfSensitiveInput({
        name: "Acme",
        description: "A friendly connector",
        config: { base_url: "https://api.acme.test" },
      }),
    ).toBe("auto");
  });

  it("ignores empty strings under sensitive keys", () => {
    expect(confirmIfSensitiveInput({ config: { token: "" } })).toBe("auto");
  });

  it("survives circular structures without throwing", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(confirmIfSensitiveInput(cycle)).toBe("auto");
  });
});

describe("predicate: confirmIfTouchesAuth", () => {
  it("flags an auth_type swap", () => {
    expect(confirmIfTouchesAuth({ auth_type: "bearer" })).toBe("confirm_before_execution");
  });

  it("flags credential rotation", () => {
    expect(confirmIfTouchesAuth({ credential: { mode: "bearer" } })).toBe(
      "confirm_before_execution",
    );
  });

  it("flags base_url repoint", () => {
    expect(confirmIfTouchesAuth({ base_url: "https://api.example.test" })).toBe(
      "confirm_before_execution",
    );
  });

  it("flags dsn change", () => {
    expect(confirmIfTouchesAuth({ dsn: "postgres://user:pw@db/x" })).toBe(
      "confirm_before_execution",
    );
  });

  it("returns auto for an unrelated patch", () => {
    expect(confirmIfTouchesAuth({ name: "Renamed" })).toBe("auto");
  });

  it("returns auto for non-objects", () => {
    expect(confirmIfTouchesAuth(null)).toBe("auto");
    expect(confirmIfTouchesAuth("string")).toBe("auto");
    expect(confirmIfTouchesAuth(undefined)).toBe("auto");
  });

  it("treats a null value at an auth key as untouched", () => {
    expect(confirmIfTouchesAuth({ credential: null })).toBe("auto");
  });
});

describe("predicate: confirmIfNonDevEnv", () => {
  it("flags prod from input", () => {
    expect(confirmIfNonDevEnv({ environment: "prod" }, CTX)).toBe("confirm_before_execution");
  });

  it("flags stage from input", () => {
    expect(confirmIfNonDevEnv({ environment: "stage" }, CTX)).toBe("confirm_before_execution");
  });

  it("returns auto when input env is dev", () => {
    expect(confirmIfNonDevEnv({ environment: "dev" }, CTX)).toBe("auto");
  });

  it("falls back to ctx.environment when input has none", () => {
    expect(confirmIfNonDevEnv({}, { ...CTX, environment: "prod" })).toBe(
      "confirm_before_execution",
    );
  });

  it("input.environment wins over ctx.environment", () => {
    expect(confirmIfNonDevEnv({ environment: "dev" }, { ...CTX, environment: "prod" })).toBe(
      "auto",
    );
  });

  it("returns auto when both are unset (dev-by-default)", () => {
    expect(confirmIfNonDevEnv({}, CTX)).toBe("auto");
  });
});

describe("predicate: confirmIfUnresolvedPlaceholders", () => {
  it("flags a literal ${var} in bindings", () => {
    expect(confirmIfUnresolvedPlaceholders({ bindings: { customer_id: "${customer.id}" } })).toBe(
      "confirm_before_execution",
    );
  });

  it("flags a placeholder anywhere in the input", () => {
    expect(confirmIfUnresolvedPlaceholders({ url: "https://api.test/${vendor}/list" })).toBe(
      "confirm_before_execution",
    );
  });

  it("flags placeholders nested in arrays", () => {
    expect(confirmIfUnresolvedPlaceholders({ bindings: { tags: ["fixed", "${dynamic}"] } })).toBe(
      "confirm_before_execution",
    );
  });

  it("returns auto for fully-resolved bindings", () => {
    expect(confirmIfUnresolvedPlaceholders({ bindings: { customer_id: "cus_123" } })).toBe("auto");
  });

  it("returns auto for an empty input", () => {
    expect(confirmIfUnresolvedPlaceholders({})).toBe("auto");
  });
});

describe("resolveExecutionMode — table coverage", () => {
  it("unknown tools resolve to auto with null reason / kind", () => {
    expect(resolveExecutionMode("unknown_tool_xyz", {}, CTX)).toEqual({
      mode: "auto",
      reason: null,
      confirmationKind: null,
    });
  });

  it("delete_connector — destructive, always confirm_before", () => {
    const r = resolveExecutionMode("delete_connector", { connector_id: "x" }, CTX);
    expect(r.mode).toBe("confirm_before_execution");
    expect(r.confirmationKind).toBe("destructive");
    expect(r.reason).toBe("Permanent connector deletion");
  });

  it("revoke_api_key — destructive, always confirm_before", () => {
    expect(resolveExecutionMode("revoke_api_key", { api_key_id: "k" }, CTX).mode).toBe(
      "confirm_before_execution",
    );
  });

  it("call_connector — external_call, always confirm_before", () => {
    const r = resolveExecutionMode("call_connector", { endpoint: "GET /x" }, CTX);
    expect(r.mode).toBe("confirm_before_execution");
    expect(r.confirmationKind).toBe("external_call");
  });

  it("save_workflow_draft / save_connector_draft — confirm_before", () => {
    expect(resolveExecutionMode("save_workflow_draft", {}, CTX).mode).toBe(
      "confirm_before_execution",
    );
    expect(resolveExecutionMode("save_connector_draft", {}, CTX).mode).toBe(
      "confirm_before_execution",
    );
  });

  it("update_connector with auth_type touches auth → confirm_before", () => {
    expect(resolveExecutionMode("update_connector", { auth_type: "bearer" }, CTX).mode).toBe(
      "confirm_before_execution",
    );
  });

  it("update_connector with name-only patch → auto", () => {
    expect(resolveExecutionMode("update_connector", { name: "Renamed" }, CTX).mode).toBe("auto");
  });

  it("update_workflow in dev → auto", () => {
    expect(
      resolveExecutionMode("update_workflow", { workflow_id: "x", environment: "dev" }, CTX).mode,
    ).toBe("auto");
  });

  it("update_workflow in prod → confirm_before", () => {
    expect(
      resolveExecutionMode("update_workflow", { workflow_id: "x", environment: "prod" }, CTX).mode,
    ).toBe("confirm_before_execution");
  });

  it("update_connector_draft with sensitive token → confirm_before", () => {
    expect(
      resolveExecutionMode(
        "update_connector_draft",
        { config: { token: "ghp_abcdefghijklmnopqrstuvwxyz012345" } },
        CTX,
      ).mode,
    ).toBe("confirm_before_execution");
  });

  it("update_connector_draft with no secrets → auto", () => {
    expect(resolveExecutionMode("update_connector_draft", { name: "Acme" }, CTX).mode).toBe("auto");
  });

  it("run_workflow in dev → auto", () => {
    expect(
      resolveExecutionMode("run_workflow", { workflow: "x", environment: "dev" }, CTX).mode,
    ).toBe("auto");
  });

  it("run_workflow in prod → confirm_before", () => {
    expect(
      resolveExecutionMode("run_workflow", { workflow: "x", environment: "prod" }, CTX).mode,
    ).toBe("confirm_before_execution");
  });

  it("run_workflow falls back to ctx.environment", () => {
    expect(
      resolveExecutionMode(
        "run_workflow",
        { workflow: "x" },
        { tenant_id: "t", environment: "stage" },
      ).mode,
    ).toBe("confirm_before_execution");
  });

  it("dry_run_workflow with placeholder bindings → confirm_before", () => {
    expect(
      resolveExecutionMode(
        "dry_run_workflow",
        { workflow_id: "x", bindings: { id: "${vendor.id}" } },
        CTX,
      ).mode,
    ).toBe("confirm_before_execution");
  });

  it("dry_run_workflow with resolved bindings → auto", () => {
    expect(
      resolveExecutionMode("dry_run_workflow", { workflow_id: "x", bindings: { id: "v_1" } }, CTX)
        .mode,
    ).toBe("auto");
  });

  it("dry_run_step with placeholder → confirm_before", () => {
    expect(
      resolveExecutionMode("dry_run_step", { step_id: "s", bindings: { x: "${y}" } }, CTX).mode,
    ).toBe("confirm_before_execution");
  });

  it("discovery / read tools default auto", () => {
    for (const t of [
      "discover_connector_endpoints",
      "fetch_connector_docs",
      "search_knowledge",
      "list_connectors",
      "list_workflows",
      "get_workflow",
    ]) {
      expect(resolveExecutionMode(t, {}, CTX).mode).toBe("auto");
    }
  });

  it("ask_user_* and cannot_help — auto (they ARE the gate)", () => {
    for (const t of [
      "ask_user_choice",
      "ask_user_confirm",
      "ask_user_form",
      "ask_user_multi",
      "ask_user_text",
      "cannot_help",
    ]) {
      expect(resolveExecutionMode(t, {}, CTX).mode).toBe("auto");
    }
  });
});

describe("policy table integrity", () => {
  it("every entry has a unique tool name", () => {
    const seen = new Set<string>();
    for (const policy of TOOL_POLICIES) {
      expect(seen.has(policy.name)).toBe(false);
      seen.add(policy.name);
    }
  });

  it("getToolPolicy returns the registered entry", () => {
    expect(getToolPolicy("delete_connector")?.confirmationKind).toBe("destructive");
  });

  it("getToolPolicy returns null for unknown tools", () => {
    expect(getToolPolicy("nope")).toBeNull();
  });

  it("every dangerous tool sits on confirm_before_execution", () => {
    const dangerous = [
      "delete_connector",
      "delete_workflow",
      "delete_knowledge_source",
      "delete_subscription",
      "revoke_api_key",
      "revoke_portal_token",
      "approve_patch_candidate",
      "approve_skill_candidate",
      "approve_discovery_artifact",
    ];
    for (const name of dangerous) {
      const policy = getToolPolicy(name);
      expect(policy).not.toBeNull();
      expect(policy?.defaultMode).toBe("confirm_before_execution");
    }
  });
});
