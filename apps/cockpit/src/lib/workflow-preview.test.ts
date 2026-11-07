import { describe, expect, test } from "bun:test";
import { ApiError } from "@/api/client";
import { translate } from "@/lib/i18n";
import {
  previewFailure,
  previewRefusalKey,
  runRefusalKey,
  workflowPreviewDefinition,
  workflowPreviewRequest,
} from "./workflow-preview";

describe("cockpit workflow previews", () => {
  test("whole workflow and step requests always hold writes", () => {
    const step = { id: "send", kind: "request", method: "POST" };
    const definition = { name: "Example", steps: [step] };
    expect(workflowPreviewRequest({ source: "draft", definition })).toEqual({
      source: "draft",
      definition,
      hold_writes: true,
    });
    expect(workflowPreviewRequest({ source: "step", step })).toEqual({
      source: "step",
      step,
      hold_writes: true,
    });
  });

  test("an edited draft retains privacy and input contracts", () => {
    const saved = {
      name: "Private briefing",
      execution_privacy: "sensitive" as const,
      input_schema: { type: "object", properties: { mode: { enum: ["daily", "weekly"] } } },
      output_schema: { type: "object" },
      steps: [{ id: "old" }],
    };
    const steps = [{ id: "new" }];
    expect(
      workflowPreviewRequest({
        source: "draft",
        definition: workflowPreviewDefinition(saved, steps),
      }),
    ).toEqual({
      source: "draft",
      definition: { ...saved, steps },
      hold_writes: true,
    });
  });

  test("an edited draft keeps every field that shapes the saved run", () => {
    const saved = {
      name: "Product briefing",
      product_id: "briefing-app",
      required_caller_kind: "user" as const,
      execution_privacy: "sensitive" as const,
      tool_effect: "read" as const,
      validation_expression: "ok = true",
      output_transform: '{"summary": summary}',
      response_filters: [
        { target: "KEYS" as const, action: "REMOVE" as const, pattern: "^token$" },
      ],
      timeout_ms: 30_000,
      max_llm_tokens_per_run: 4_000,
      runtime: { stdlib_version: "1" },
      execution_guards: { input_bytes: { question: 2_000 } },
      caller_erasure: "on_success" as const,
      steps: [{ id: "old" }],
    };
    const steps = [{ id: "new" }];
    expect(workflowPreviewDefinition(saved, steps)).toEqual({ ...saved, steps });
  });

  test("a definition without a name previews under an empty name", () => {
    const unnamed = { execution_privacy: "sensitive" as const };
    expect(workflowPreviewDefinition(unnamed, [{ id: "a" }])).toEqual({
      ...unnamed,
      name: "",
      steps: [{ id: "a" }],
    });
  });

  test("selected preview input travels with the sensitive draft", () => {
    const definition = {
      name: "Briefing",
      execution_privacy: "sensitive" as const,
      steps: [{ id: "get" }],
    };
    expect(
      workflowPreviewRequest({ source: "draft", definition, input: { mode: "weekly" } }),
    ).toEqual({ source: "draft", definition, input: { mode: "weekly" }, hold_writes: true });
  });

  test("a refused trial run keeps the engine code next to its message", () => {
    const refusal = new ApiError(
      403,
      {
        code: "caller_product_mismatch",
        message: "This caller does not match the workflow's product.",
      },
      null,
    );
    expect(previewFailure(refusal)).toEqual({
      code: "caller_product_mismatch",
      message: "This caller does not match the workflow's product.",
    });
    expect(previewFailure(new Error("network down"))).toEqual({
      code: null,
      message: "network down",
    });
    expect(previewFailure("plain")).toEqual({ code: null, message: "plain" });
    expect(previewFailure(null)).toEqual({ code: null, message: "null" });
    expect(previewFailure(Object.assign(new Error("x"), { code: "" }))).toEqual({
      code: null,
      message: "x",
    });
  });

  test("product caller refusals map to sentences that say what to do", () => {
    expect(previewRefusalKey("caller_saved_workflow_required")).toBe(
      "workflow.preview.refusal.savedRequired",
    );
    expect(previewRefusalKey("caller_product_mismatch")).toBe(
      "workflow.preview.refusal.productCaller",
    );
    expect(previewRefusalKey("caller_required")).toBeNull();
    expect(previewRefusalKey("constructor")).toBeNull();
    expect(previewRefusalKey(null)).toBeNull();
    expect(translate("en", "workflow.preview.refusal.savedRequired")).toBe(
      "This sign-in belongs to an app and may only run saved workflows, so a trial run of a draft or a single step is not possible. Save the workflow and run the saved version.",
    );
    expect(translate("de", "workflow.preview.refusal.savedRequired")).toBe(
      "Diese Anmeldung gehört zu einer App und darf nur gespeicherte Workflows ausführen. Ein Probelauf eines Entwurfs oder eines einzelnen Schritts ist damit nicht möglich. Speichere den Workflow und führe die gespeicherte Version aus.",
    );
    expect(translate("en", "workflow.preview.refusal.productCaller")).toBe(
      "This workflow belongs to an app. Only that app's users can run it, and only once it is saved, so a trial run from here is not possible. Save the workflow and start it from the app.",
    );
    expect(translate("de", "workflow.preview.refusal.productCaller")).toBe(
      "Dieser Workflow gehört zu einer App. Nur Nutzer dieser App können ihn ausführen, und erst, wenn er gespeichert ist. Ein Probelauf von hier aus ist deshalb nicht möglich. Speichere den Workflow und starte ihn über die App.",
    );
  });

  test("a saved run refused for another product's workflow names the app", () => {
    const refusal = new ApiError(403, { code: "caller_product_mismatch", message: "m" }, null);
    expect(runRefusalKey(refusal)).toBe("run.productCaller");
    expect(
      runRefusalKey(new ApiError(403, { code: "caller_saved_workflow_required" }, null)),
    ).toBeNull();
    expect(runRefusalKey(new Error("boom"))).toBeNull();
    expect(translate("en", "run.productCaller")).toBe(
      "Not started: this workflow belongs to an app, so only that app's users can run it. Start it from the app.",
    );
    expect(translate("de", "run.productCaller")).toBe(
      "Nicht gestartet: Dieser Workflow gehört zu einer App, deshalb können ihn nur Nutzer dieser App ausführen. Starte ihn über die App.",
    );
  });
});
