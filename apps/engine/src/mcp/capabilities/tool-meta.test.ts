import { describe, expect, test } from "bun:test";
import { listConversationTools } from "./conversations.ts";
import {
  buildConversationToolMeta,
  buildToolAnnotations,
  buildWorkflowToolAnnotations,
} from "./tool-meta.ts";

describe("buildToolAnnotations", () => {
  test("approval replay advertises its possible external write without a second decision", () => {
    expect(buildToolAnnotations("tenant_read", "confirm_tool_call")).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(
      buildConversationToolMeta("tenant_read", "confirm_tool_call").subkit.confirm_required,
    ).toBe(false);
  });
  test("read tools advertise readOnly + idempotent, not destructive", () => {
    const a = buildToolAnnotations("tenant_read", "get_workflow");
    expect(a.readOnlyHint).toBe(true);
    expect(a.idempotentHint).toBe(true);
    expect(a.destructiveHint).toBe(false);
  });

  test("write tools are not read-only AND are advertised destructive (spec default)", () => {
    const a = buildToolAnnotations("tenant_write", "save_settings");
    expect(a.readOnlyHint).toBe(false);
    expect(a.idempotentHint).toBe(false);
    expect(a.destructiveHint).toBe(true);
  });

  test("write-capable tools mislabeled tenant_read are advertised as writes", () => {
    for (const name of ["call_connector", "authenticate", "self_healing_scan"]) {
      const a = buildToolAnnotations("tenant_read", name);
      expect(a.readOnlyHint).toBe(false);
      expect(a.destructiveHint).toBe(true);
    }
  });

  test("additive session-only writes are not read-only but not destructive", () => {
    for (const name of [
      "conversation_start",
      "conversation_append",
      "conversation_respond_elicitation",
    ]) {
      const a = buildToolAnnotations("tenant_write", name);
      expect(a.readOnlyHint).toBe(false);
      expect(a.destructiveHint).toBe(false);
    }
  });

  test("no real write ever asserts destructiveHint:false", () => {
    for (const name of ["save_workflow_draft", "import_connector_from_spec", "delete_workflow"]) {
      expect(buildToolAnnotations("tenant_write", name).destructiveHint).toBe(true);
    }
  });

  test("all four spec hints are set explicitly (strict clients treat absent as write)", () => {
    const a = buildToolAnnotations("tenant_read", "get_workflow");
    for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      expect(typeof (a as Record<string, unknown>)[key]).toBe("boolean");
    }
  });

  test("external-reaching tools are open-world; internal CRUD/reads are closed-world", () => {
    for (const name of [
      "call_connector",
      "probe_connector",
      "authenticate_oauth",
      "dry_run_workflow",
      "manage_service_package_skill",
    ]) {
      expect(buildToolAnnotations("tenant_write", name).openWorldHint).toBe(true);
    }
    for (const name of ["get_workflow", "list_workflows", "delete_workflow", "update_connector"]) {
      expect(buildToolAnnotations("tenant_read", name).openWorldHint).toBe(false);
    }
  });
});

describe("buildWorkflowToolAnnotations", () => {
  test("workflow runs are open-world, not read-only, AND destructive (gated by client)", () => {
    const a = buildWorkflowToolAnnotations();
    expect(a.readOnlyHint).toBe(false);
    expect(a.destructiveHint).toBe(true);
    expect(a.openWorldHint).toBe(true);
  });

  test("versioned read and reversible workflow effects produce precise hints", () => {
    expect(buildWorkflowToolAnnotations("read")).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(buildWorkflowToolAnnotations("reversible_write")).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });
});

describe("listConversationTools annotations", () => {
  const tools = listConversationTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  test("every conversation tool carries annotations", () => {
    for (const t of tools) expect(t.annotations).toBeDefined();
  });

  test("conversation_start is a non-destructive write (so strict clients permit it)", () => {
    const a = byName.get("conversation_start")?.annotations;
    expect(a?.readOnlyHint).toBe(false);
    expect(a?.destructiveHint).toBe(false);
  });

  test("conversation_get / conversation_commit are read-only", () => {
    expect(byName.get("conversation_get")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("conversation_commit")?.annotations?.readOnlyHint).toBe(true);
  });

  test("conversation_start description names no engine-internal tools (strict clients call phantom tools)", () => {
    const desc = byName.get("conversation_start")?.description ?? "";
    for (const phantom of ["author_workflow", "edit_workflow_patch", "dry_run_workflow"]) {
      expect(desc).not.toContain(phantom);
    }
  });
});
