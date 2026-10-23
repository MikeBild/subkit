import { expect, test } from "bun:test";
import type { ToolPart } from "@/components/ai-elements/tool";
import { translate } from "@/lib/i18n";
import {
  chatJudgeFindings,
  chatSensitivePreview,
  findingsInstruction,
  latestDryRunCallId,
  openFindings,
  workflowRefOf,
} from "./chat-preview-cards";

function dryRun(output: unknown, state: ToolPart["state"] = "output-available"): ToolPart {
  return {
    type: "dynamic-tool",
    toolName: "dry_run_workflow",
    toolCallId: "call",
    state,
    input: {},
    output,
  } as ToolPart;
}

const schemaOnly = {
  mode: "schema_only",
  status: "passed",
  structure_checked: true,
  content_checked: false,
  content_withheld: true,
  requests: "held",
  steps: [{ id: "read", kind: "connector" }],
  expressions: [],
  counts: { steps: 3, expressions: 4, compile_errors: 0 },
  verification_stage: "schema_only",
  note: "Structure checked, content not checked.",
};

const target = { kind: "workflow", id: "wf-1", slug: "upraft-auth-notify", name: "Auth notify" };

test("a passed schema-only result becomes the first preview stage with its workflow", () => {
  expect(
    chatSensitivePreview(
      dryRun({ save_required: true, target_ref: target, schema_only_preview: schemaOnly }),
    ),
  ).toEqual({
    passed: true,
    stage: "schema_only",
    steps: 3,
    expressions: 4,
    compileErrors: 0,
    requestsHeld: true,
    saveRequired: true,
    workflow: { id: "wf-1", label: "upraft-auth-notify" },
  });
});

test("a failed schema-only result arrives as a tool error and still renders", () => {
  const preview = chatSensitivePreview(
    dryRun(
      {
        error_code: "preview_needs_repair",
        schema_only_preview: {
          ...schemaOnly,
          status: "failed",
          counts: { steps: 3, expressions: 4, compile_errors: 2 },
        },
      },
      "output-error",
    ),
  );
  expect(preview?.passed).toBe(false);
  expect(preview?.compileErrors).toBe(2);
  expect(preview?.workflow).toBeNull();
});

test("other tools, running calls and plain previews are not sensitive previews", () => {
  expect(chatSensitivePreview(dryRun({ steps_ran: 2 }))).toBeNull();
  expect(chatSensitivePreview(dryRun({ schema_only_preview: schemaOnly }, "input-available"))).toBe(
    null,
  );
  expect(
    chatSensitivePreview({
      ...dryRun({ schema_only_preview: schemaOnly }),
      toolName: "run_workflow",
    } as ToolPart),
  ).toBeNull();
});

test("the workflow reference falls back from the target to the resource and the saved id", () => {
  expect(workflowRefOf({ resource_kind: "workflow", resource_id: "wf-2" })).toEqual({
    id: "wf-2",
    label: null,
  });
  expect(workflowRefOf({ workflow_id: "wf-3", slug: "weekly-report" })).toEqual({
    id: "wf-3",
    label: "weekly-report",
  });
  expect(workflowRefOf({ target_ref: { kind: "connector", id: "c-1" } })).toBeNull();
});

test("a partial or failed judge verdict with missing entries becomes findings", () => {
  const findings = chatJudgeFindings(
    dryRun(
      {
        target_ref: target,
        judge: {
          verdict: "partial",
          reason: "Not all figures are delivered.",
          missing: ["Date is in UTC", "  ", "Subject is missing"],
        },
      },
      "output-error",
    ),
  );
  expect(findings).toEqual({
    verdict: "partial",
    reason: "Not all figures are delivered.",
    missing: ["Date is in UTC", "Subject is missing"],
    workflow: { id: "wf-1", label: "upraft-auth-notify" },
  });
});

test("passing, skipped or empty judge verdicts render no findings", () => {
  expect(
    chatJudgeFindings(dryRun({ judge: { verdict: "passes", reason: "ok", missing: [] } })),
  ).toBeNull();
  expect(chatJudgeFindings(dryRun({ judge: { verdict: "skipped", reason: "no_goal" } }))).toBe(
    null,
  );
  expect(
    chatJudgeFindings(dryRun({ judge: { verdict: "failed", reason: "x", missing: [] } })),
  ).toBeNull();
});

test("instructions name the workflow with its @ reference and list every finding", () => {
  const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate("de", key, values);
  expect(
    findingsInstruction(t, { id: "wf-1", label: "weekly-report" }, ["Betreff fehlt", "UTC"]),
  ).toEqual({
    message:
      "Behebe diese Befunde der Vorschau in @weekly-report und prüfe die Vorschau danach erneut:\n- Betreff fehlt\n- UTC",
    references: [{ type: "workflow", id: "wf-1", label: "weekly-report" }],
  });
  expect(findingsInstruction(t, null, ["Betreff fehlt"])).toEqual({
    message:
      "Behebe diesen Befund der Vorschau und prüfe die Vorschau danach erneut:\n- Betreff fehlt",
    references: [],
  });
  expect(findingsInstruction(t, { id: "wf-1", label: "Auth notify" }, ["x"]).references).toEqual(
    [],
  );
});

test("only open findings stay open", () => {
  expect(openFindings(["a", "b", "c"], { 0: "handed", 2: "kept" })).toEqual([1]);
});

test("only the newest dry run in the conversation keeps live finding actions", () => {
  const call = (id: string, tool: string) => ({ type: "tool_call", call_id: id, tool });
  expect(
    latestDryRunCallId([
      { parts: [call("a", "dry_run_workflow")] },
      { parts: [call("b", "dry_run_workflow"), call("c", "save_workflow_draft")] },
      { parts: [{ type: "text", text: "ok" }] },
    ]),
  ).toBe("b");
  expect(latestDryRunCallId([{ parts: [call("c", "save_workflow_draft")] }])).toBeNull();
});
