import { describe, expect, test } from "bun:test";

import { decideConfirm } from "./confirm-decision.ts";

describe("decideConfirm — a local decision, independent of surface and category", () => {
  test("every confirm-before call requires a matching durable approval", () => {
    for (const category of ["tenant_read", "tenant_write", "draft_write"] as const) {
      for (const surface of [
        undefined,
        "mcp",
        "chat",
        "web",
        "sk_headless",
        "sk_interactive",
      ] as const) {
        for (const resolverRule of [
          "inline_credential",
          "never_gate",
          "permission_mode",
          "conversation_override",
          "computed_from_input",
          "tool_default",
          "category_default",
        ] as const) {
          for (const tool of [
            "create_knowledge_source",
            "save_workflow_draft",
            "delete_workflow",
            "probe_connector",
          ]) {
            for (const priorApproval of [false, true]) {
              const decision = decideConfirm({
                resolvedMode: "confirm_before_execution",
                priorApproval,
                category,
                tool,
                ...(surface ? { surface } : {}),
                resolverRule,
              });
              expect(decision).toEqual({
                pause: !priorApproval,
                reason: priorApproval ? "prior_approval_present" : "confirm_required",
              });
            }
          }
        }
      }
    }
  });

  test("autonomous preparation and configured post-execution review do not pre-pause", () => {
    for (const resolvedMode of ["no_confirm", "confirm_after_execution"] as const) {
      for (const category of ["tenant_read", "tenant_write", "draft_write"] as const) {
        for (const surface of ["mcp", "chat"] as const) {
          expect(
            decideConfirm({
              resolvedMode,
              priorApproval: false,
              category,
              tool: "create_knowledge_source",
              surface,
            }),
          ).toEqual({ pause: false, reason: "mode_not_confirm_before_execution" });
        }
      }
    }
  });
});
