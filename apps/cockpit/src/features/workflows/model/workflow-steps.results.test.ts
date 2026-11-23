import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildVersion,
  connectorNameOf,
  type ExecutionStep,
  formatDuration,
  joinStepsWithLastRun,
  maskIdentifiers,
  previewSummary,
  readStepDefinition,
  stepKindKey,
  stepResultPreview,
} from "@/features/workflows/model/workflow-steps";
import { block, essence, read, UUID } from "@/features/workflows/model/workflow-steps-fixtures";

function runStep(overrides: Partial<ExecutionStep> & { step_key: string }): ExecutionStep {
  return {
    id: `run-${overrides.step_key}`,
    step_index: 0,
    kind: "request",
    status: "succeeded",
    duration_ms: 12,
    retry_count: 0,
    result_storage_uri: null,
    result_preview: null,
    output_preview: null,
    error: null,
    request_meta: null,
    started_at: "2030-08-17T10:00:00.000Z",
    finished_at: "2030-08-17T10:00:01.000Z",
    ...overrides,
  } as ExecutionStep;
}

describe("what stands outside a fenced block", () => {
  test("an identifier in the one-line essence is masked", () => {
    const step = { id: "load", kind: "request", path: `/v1/databases/${UUID}` };
    expect(essence(step)).toBe("GET /v1/databases/…");
    expect(maskIdentifiers(`run/${UUID} failed`)).toBe("run/… failed");
  });

  test("the same value in the step's block is left whole", () => {
    const step = { id: "load", kind: "request", path: `/v1/databases/${UUID}` };
    expect(block(read(step).blocks, "workflow.block.request")?.code).toBe(
      `GET /v1/databases/${UUID}`,
    );
  });
});

describe("durations", () => {
  test("use the largest unit that keeps them whole", () => {
    expect(formatDuration(250)).toBe("250 ms");
    expect(formatDuration(1_500)).toBe("1.5 s");
    expect(formatDuration(90_000)).toBe("90 s");
    expect(formatDuration(300_000)).toBe("5 min");
    expect(formatDuration(7_200_000)).toBe("2 h");
  });
});

describe("joining a definition with its last run", () => {
  const steps = [
    { id: "fetch", kind: "request" },
    { id: "shape", kind: "transform" },
  ];

  test("matches by step id and leaves an unrun step empty", () => {
    const views = joinStepsWithLastRun(steps, [
      runStep({ step_key: "fetch", result_preview: "ok" }),
    ]);
    expect(views[0]?.lastRun?.result_preview).toBe("ok");
    expect(views[1]?.lastRun).toBeNull();
  });

  test("keeps the latest attempt when a step ran more than once", () => {
    const views = joinStepsWithLastRun(steps, [
      runStep({ step_key: "fetch", step_index: 0, result_preview: "first" }),
      runStep({ step_key: "fetch", step_index: 3, result_preview: "retry" }),
    ]);
    expect(views[0]?.lastRun?.result_preview).toBe("retry");
  });
});

describe("step result preview", () => {
  test("an error outranks a result so a failure is never shown as output", () => {
    expect(stepResultPreview(runStep({ step_key: "a", error: "boom", result_preview: "ok" }))).toBe(
      "boom",
    );
  });

  test("prefers the structured value over the string blurb", () => {
    expect(
      stepResultPreview(
        runStep({
          step_key: "a",
          output_preview: { count: 2 },
          result_preview: "two",
        }),
      ),
    ).toBe('{\n  "count": 2\n}');
  });

  test("a step that never ran has nothing to show", () => {
    expect(stepResultPreview(null)).toBeNull();
  });

  test("a run's output is payload: references and instants stay as the run wrote them", () => {
    const output = { run_id: UUID, finished_at: "2030-08-25T22:00:00.000Z" };
    expect(stepResultPreview(runStep({ step_key: "a", output_preview: output }))).toBe(
      JSON.stringify(output, null, 2),
    );
    const preview = `{"id":"${UUID}","finished_at":"2030-08-25T22:00:00.000Z"}`;
    expect(
      stepResultPreview(runStep({ step_key: "a", output_preview: null, result_preview: preview })),
    ).toBe(preview);
  });
});

describe("the connector a step uses", () => {
  const names = new Map([["d11b5b98-6c7b-4919-9276-74e5f4b4891b", "Radar API"]]);

  test("resolves a reference to the connector name", () => {
    const definition = readStepDefinition(
      {
        id: "a",
        kind: "request",
        connector_id: "d11b5b98-6c7b-4919-9276-74e5f4b4891b",
      },
      0,
    );
    expect(definition.connector).toBeNull();
    expect(connectorNameOf(definition, names)).toBe("Radar API");
  });

  test("shows nothing rather than the raw reference when it cannot be resolved", () => {
    const definition = readStepDefinition({ id: "a", connector_id: "unknown-id" }, 0);
    expect(connectorNameOf(definition, names)).toBeNull();
  });
});

describe("step kinds", () => {
  const source = readFileSync(
    new URL("../../../../../engine/src/workflows/types.ts", import.meta.url).pathname,
    "utf8",
  );
  const steps = source.slice(
    source.indexOf("export const HttpRequestStepSchema"),
    source.indexOf("export const StepSchema"),
  );
  const kinds = [
    ...new Set(
      [...steps.matchAll(/^ {4}kind: z\.literal\("([a-z_]+)"\)/gm)].map((m) => m[1] ?? ""),
    ),
  ];

  test("the engine's step schema is read", () => {
    expect(kinds).toContain("request");
    expect(kinds).toContain("wait_for_event");
    expect(kinds.length).toBeGreaterThanOrEqual(7);
  });

  test("every kind of the engine's step schema has a word and a reading", () => {
    for (const kind of kinds) {
      expect(stepKindKey({ kind }), kind).not.toBe("workflow.stepType");
      expect<string>(read({ id: "x", kind }).essence.kind, kind).toBe(kind);
    }
  });
});

describe("extractor transforms", () => {
  const source = readFileSync(
    new URL("../../../../../engine/src/workflows/types.ts", import.meta.url).pathname,
    "utf8",
  );
  const transform = source.slice(
    source.indexOf('kind: z.literal("transform")'),
    source.indexOf("silence_warnings"),
  );
  const configs = [
    ...transform.matchAll(/^ {4}([a-z_]+): [A-Za-z]+ConfigSchema\.optional\(\)/gm),
  ].map((match) => match[1] ?? "");

  test("the engine's extractor config blocks are read", () => {
    expect(configs).toEqual(["readability", "markdown", "structured_data"]);
  });

  test("every extractor's configuration is shown", () => {
    for (const name of configs) {
      const { blocks } = readStepDefinition(
        {
          id: "extract",
          kind: "transform",
          language: "html-to-markdown",
          [name]: { marker: name },
        },
        0,
      );
      expect(blocks.map((entry) => entry.code).join("\n"), name).toContain(
        JSON.stringify({ marker: name }, null, 2),
      );
    }
  });

  test("an html-to-markdown transform shows its markdown settings", () => {
    const { blocks } = readStepDefinition(
      {
        id: "to_md",
        kind: "transform",
        language: "html-to-markdown",
        markdown: { heading_style: "atx", strip_images: true },
      },
      0,
    );
    expect(blocks).toEqual([
      {
        labelKey: "workflow.block.settings",
        language: "json",
        code: JSON.stringify({ heading_style: "atx", strip_images: true }, null, 2),
      },
    ]);
  });
});

describe("the version the build tab shows", () => {
  const saved = [{ id: "fetch", kind: "request" }];
  const draft = { version_id: "v2", version: 2, definition: { steps: saved } };

  test("a saved version that is not active yet is shown with its steps", () => {
    const shown = buildVersion(
      { current_version_id: "v1", current_version: 1, draft_version_id: "v2", steps: [] },
      { data: draft, settled: true },
    );
    expect(shown).toEqual({
      steps: saved,
      definition: draft.definition,
      versionId: "v2",
      version: 2,
      saved: true,
      pending: false,
    });
  });

  test("a new workflow without an active version shows its saved steps, never zero", () => {
    const shown = buildVersion(
      { current_version_id: null, current_version: null, draft_version_id: "v2", steps: [] },
      { data: draft, settled: true },
    );
    expect(shown.steps).toHaveLength(1);
    expect(shown.saved).toBe(true);
  });

  test("while the saved version loads, no step count is claimed", () => {
    const shown = buildVersion(
      { current_version_id: null, current_version: null, draft_version_id: "v2", steps: [] },
      { data: undefined, settled: false },
    );
    expect(shown.pending).toBe(true);
  });

  test("an answer for another saved version is not taken for this one", () => {
    const shown = buildVersion(
      { current_version_id: "v1", current_version: 1, draft_version_id: "v3", steps: saved },
      { data: draft, settled: true },
    );
    expect(shown).toMatchObject({ versionId: "v1", saved: false, pending: false });
  });

  test("when the active version is the newest, it is what the tab shows", () => {
    const shown = buildVersion(
      { current_version_id: "v2", current_version: 2, draft_version_id: "v2", steps: saved },
      { data: undefined, settled: true },
    );
    expect(shown).toEqual({
      steps: saved,
      definition: null,
      versionId: "v2",
      version: 2,
      saved: false,
      pending: false,
    });
  });
});

describe("a preview result in words", () => {
  test("counts ran and held steps without internal fields", () => {
    const summary = previewSummary(
      {
        execution_id: "e",
        hold_writes: true,
        status: "succeeded",
        output: { sent: 1 },
        steps: [
          { step_key: "fetch", status: "succeeded" },
          { step_key: "send", status: "succeeded", held: true },
        ],
      },
      3,
    );
    expect(summary).toEqual({
      status: "succeeded",
      ran: 2,
      total: 3,
      held: 1,
      stoppedAt: null,
      output: { sent: 1 },
      error: null,
    });
    expect(JSON.stringify(summary)).not.toContain("execution_id");
    expect(JSON.stringify(summary)).not.toContain("hold_writes");
  });

  test("a failed or unreadable result is never shown as a success", () => {
    const failed = previewSummary(
      {
        status: "failed",
        error: { code: "http_4xx", message: "404 Not Found" },
        steps: [{ step_key: "fetch", status: "failed" }],
      },
      1,
    );
    expect(failed).toMatchObject({ status: "failed", stoppedAt: "fetch", error: "404 Not Found" });
    expect(previewSummary({}, 2).status).toBe("failed");
  });
});
