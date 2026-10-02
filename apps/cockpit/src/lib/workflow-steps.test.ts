import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { translate } from "@/lib/i18n";
import {
  connectorNameOf,
  type ExecutionStep,
  formatDuration,
  joinStepsWithLastRun,
  maskIdentifiers,
  readStepDefinition,
  type StepBlock,
  stepEssenceText,
  stepResultPreview,
  workflowStepKindKey,
} from "./workflow-steps";

const UUID = "457df8bc-2fe7-4a44-8dba-0acfa31821c5";
/** A workflow placeholder as an author writes it — text, not a template. */
const PLACEHOLDER = ["$", "{input.name}"].join("");
const reference = (path: string) => ["$", `{${path}}`].join("");
const de: Parameters<typeof stepEssenceText>[1] = (key, values) => translate("de", key, values);
const en: Parameters<typeof stepEssenceText>[1] = (key, values) => translate("en", key, values);

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

const read = (step: Record<string, unknown>) => readStepDefinition(step, 0);
const essence = (step: Record<string, unknown>, connector: string | null = null) =>
  stepEssenceText(read(step), de, { connector });
const block = (blocks: readonly StepBlock[], labelKey: StepBlock["labelKey"]) =>
  blocks.find((entry) => entry.labelKey === labelKey);

describe("step definition", () => {
  test("names a step without an id by its position instead of leaving it blank", () => {
    expect(readStepDefinition({ kind: "request" }, 2).id).toBe("step-3");
  });

  test("a kind this build does not know says nothing it cannot back", () => {
    const definition = read({ id: "x", kind: "future_kind" });
    expect(definition.essence).toEqual({ kind: "other" });
    expect(definition.blocks).toEqual([]);
    expect(essence({ id: "x", kind: "future_kind" })).toBe("");
    expect(workflowStepKindKey("future_kind")).toBe("workflow.stepType");
  });
});

describe("request steps", () => {
  const step = {
    id: "fetch_data",
    kind: "request",
    method: "POST",
    path: "/users",
    query: { limit: 10, active: true },
    headers: { Accept: "application/json", Authorization: "Bearer plain-token" },
    body: { name: PLACEHOLDER, parent: UUID },
    max_retries: 2,
    side_effects: "write",
    timeout_ms: 30_000,
    on_error: "continue",
  };

  test("the line says method, path and the connector", () => {
    expect(essence(step, "Example API")).toBe("POST /users · Example API");
    expect(essence({ id: "a", kind: "request", url: "https://api.example.org/x" })).toBe(
      "GET https://api.example.org/x",
    );
  });

  test("the configuration shows the request line, query, headers and body", () => {
    const { blocks } = read(step);
    expect(block(blocks, "workflow.block.request")?.code).toBe("POST /users");
    expect(block(blocks, "workflow.block.query")?.code).toBe(
      JSON.stringify({ limit: 10, active: true }, null, 2),
    );
    expect(block(blocks, "workflow.block.body")?.code).toBe(
      JSON.stringify({ name: PLACEHOLDER, parent: UUID }, null, 2),
    );
  });

  test("a literal secret under a credential-shaped header is masked", () => {
    const headers = block(read(step).blocks, "workflow.block.headers")?.code ?? "";
    expect(headers).toContain("Accept: application/json");
    expect(headers).toContain("Authorization: •••");
    expect(headers).not.toContain("plain-token");
  });

  test("a reference is configuration, not a secret: it is shown byte for byte", () => {
    const headers =
      block(
        read({
          id: "a",
          kind: "request",
          path: "/x",
          headers: {
            Authorization: "Bearer {{credentials.token}}",
            "X-Api-Key": reference("input.key"),
            "X-Signature": `sha256=${reference("steps.sign.data.digest")}`,
            "X-Request-Token": "{{input.id}}",
            Cookie: "session=abc123",
          },
        }).blocks,
        "workflow.block.headers",
      )?.code ?? "";
    expect(headers.split("\n")).toEqual([
      "Authorization: Bearer {{credentials.token}}",
      `X-Api-Key: ${reference("input.key")}`,
      `X-Signature: sha256=${reference("steps.sign.data.digest")}`,
      "X-Request-Token: {{input.id}}",
      // No reference in it: a literal credential stays masked.
      "Cookie: •••",
    ]);
  });

  test("retries, effect, time limit and error handling are facts", () => {
    expect(read(step).facts).toEqual([
      { labelKey: "workflow.fact.retries", value: "2" },
      { labelKey: "catalog.sideEffects", valueKey: "sideEffects.write" },
      { labelKey: "workflow.fact.timeout", value: "30 s" },
      { labelKey: "workflow.fact.onError", valueKey: "workflow.fact.onErrorContinue" },
    ]);
    // The default — fail on error, no retries — is not worth a row.
    expect(read({ id: "a", kind: "request", path: "/x", on_error: "fail" }).facts).toEqual([]);
  });

  test("a SQL request names its statement and shows it whole", () => {
    const sql = {
      id: "load",
      kind: "request",
      method: "SELECT",
      connector_id: UUID,
      sql: { query: "\n  SELECT id, name\n  FROM customers\n  WHERE id = $1", params: [42] },
    };
    expect(essence(sql, "Lager-DB")).toBe("SQL · SELECT id, name · Lager-DB");
    const { blocks } = read(sql);
    expect(block(blocks, "workflow.block.sql")?.language).toBe("sql");
    expect(block(blocks, "workflow.block.sql")?.code).toBe(sql.sql.query);
    expect(block(blocks, "workflow.block.sqlParams")?.code).toBe("[\n  42\n]");
    // There is no HTTP request line for a statement.
    expect(block(blocks, "workflow.block.request")).toBeUndefined();
  });

  test("a GraphQL request shows its query and variables", () => {
    const graphql = {
      id: "issues",
      kind: "request",
      connector_id: UUID,
      graphql: { operation: "query", query: "query Issues { issues { id } }", variables: { n: 5 } },
    };
    expect(essence(graphql)).toBe("GraphQL · query Issues { issues { id } }");
    const { blocks } = read(graphql);
    expect(block(blocks, "workflow.block.graphql")?.language).toBe("graphql");
    expect(block(blocks, "workflow.block.variables")?.code).toBe('{\n  "n": 5\n}');
  });

  test("an object-storage request names its key", () => {
    const s3 = {
      id: "store",
      kind: "request",
      method: "PUT",
      connector_id: UUID,
      s3: { key: "reports/latest.json" },
    };
    expect(essence(s3)).toBe("Speicher · reports/latest.json");
    expect(block(read(s3).blocks, "workflow.block.storage")?.code).toContain("reports/latest.json");
  });

  test("a tool call on a remote server names the tool and shows its arguments", () => {
    const mcp = {
      id: "notify",
      kind: "request",
      connector_id: UUID,
      mcp: { operation: "call_tool", tool: "send_message", arguments: { channel: "ops" } },
    };
    expect(essence(mcp)).toBe("MCP · send_message");
    expect(block(read(mcp).blocks, "workflow.block.arguments")?.code).toBe(
      '{\n  "channel": "ops"\n}',
    );
  });
});

describe("control-flow steps", () => {
  test("a branch says its condition and where each way leads", () => {
    const step = {
      id: "check_status",
      kind: "branch",
      when: "fetch_data.status = 200",
      then_steps: ["shape_success"],
      else_steps: ["shape_failure"],
    };
    expect(read(step).essence).toEqual({
      kind: "branch",
      when: "fetch_data.status = 200",
      thenSteps: ["shape_success"],
      elseSteps: ["shape_failure"],
    });
    expect(essence(step)).toBe("wenn fetch_data.status = 200 → shape_success, sonst shape_failure");
    expect(stepEssenceText(read(step), en, { connector: null })).toBe(
      "if fetch_data.status = 200 → shape_success, else shape_failure",
    );
    expect(block(read(step).blocks, "workflow.block.condition")?.code).toBe(
      "fetch_data.status = 200",
    );
  });

  test("a branch without an else names only the one way", () => {
    expect(essence({ id: "b", kind: "branch", when: "ok", then_steps: ["a", "b"] })).toBe(
      "wenn ok → a, b",
    );
  });

  test("a loop says what it iterates over and which steps it runs", () => {
    expect(
      essence({ id: "each", kind: "loop", over: "fetch.data.items", body: ["send", "log"] }),
    ).toBe("für jedes Element aus fetch.data.items: send, log");
    const selector = read({
      id: "each",
      kind: "loop",
      data_selector: "(sourceData) => sourceData.fetch.data",
      body: ["send"],
      fail_fast: true,
    });
    expect(selector.essence).toEqual({
      kind: "loop",
      over: "(sourceData) => sourceData.fetch.data",
      body: ["send"],
    });
    expect(selector.facts).toEqual([
      { labelKey: "workflow.fact.failFast", valueKey: "common.yes" },
    ]);
    // The loop's own source is not repeated as an output selector.
    expect(block(selector.blocks, "workflow.block.selector")).toBeUndefined();
  });

  test("inline iteration on any step is shown as written", () => {
    const step = { id: "a", kind: "request", path: "/x", for_each: "(s) => s.list.data" };
    expect(block(read(step).blocks, "workflow.block.forEach")?.code).toBe("(s) => s.list.data");
  });

  test("parallel steps list their branches", () => {
    const step = { id: "fan", kind: "parallel", branches: [["a", "b"], ["c"]] };
    expect(read(step).essence).toEqual({ kind: "parallel", branches: [["a", "b"], ["c"]] });
    expect(essence(step)).toBe("gleichzeitig: a, b ‖ c");
  });

  test("a call names the workflow it runs, never its identifier", () => {
    const step = {
      id: "sub",
      kind: "call",
      workflow_id: UUID,
      workflow_slug: "send-report",
      input: { a: 1 },
    };
    expect(read(step).essence).toEqual({ kind: "call", workflowId: UUID, slug: "send-report" });
    expect(essence(step)).toBe("startet send-report");
    expect(essence({ id: "sub", kind: "call", workflow_id: UUID })).toBe(
      "startet einen anderen Workflow",
    );
    expect(
      stepEssenceText(read(step), de, { connector: null, calledWorkflow: "Bericht senden" }),
    ).toBe("startet Bericht senden");
    expect(block(read(step).blocks, "workflow.block.input")?.code).toBe('{\n  "a": 1\n}');
  });

  test("a wait says how long", () => {
    expect(essence({ id: "pause", kind: "wait", duration_ms: 90_000 })).toBe("wartet 90 s");
    expect(essence({ id: "pause", kind: "wait" })).toBe("Wartezeit");
  });

  test("a wait for an event names the event and its limit", () => {
    const step = {
      id: "approval",
      kind: "wait_for_event",
      event_name: "invoice.approved",
      match: { path: "outcome", equals: "approved" },
      timeout_ms: 7_200_000,
      on_timeout: "escalate",
    };
    expect(read(step).essence).toEqual({
      kind: "wait_for_event",
      event: "invoice.approved",
      timeoutMs: 7_200_000,
      onTimeout: "escalate",
    });
    expect(essence(step)).toBe("wartet auf invoice.approved, höchstens 2 h");
    expect(block(read(step).blocks, "workflow.block.match")?.code).toContain('"outcome"');
    // The limit is in the sentence; it is not a second fact below it.
    expect(read(step).facts).toEqual([]);
  });

  test("a transformation names its language and shows the expression whole", () => {
    const expression = `return { id: "${UUID}", at: "2030-08-25T22:00:00.000Z" };`;
    const step = { id: "shape", kind: "transform", expression };
    expect(essence(step)).toBe("JavaScript");
    const code = block(read(step).blocks, "workflow.block.expression");
    expect(code?.language).toBe("javascript");
    // Payload: byte for byte, identifiers and instants included.
    expect(code?.code).toBe(expression);
    expect(essence({ id: "md", kind: "transform", language: "html-to-markdown" })).toBe(
      "HTML → Markdown",
    );
  });
});

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
    const legacy = `{"id":"${UUID}","finished_at":"2030-08-25T22:00:00.000Z"}`;
    expect(
      stepResultPreview(runStep({ step_key: "a", output_preview: null, result_preview: legacy })),
    ).toBe(legacy);
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
  // Read from the engine's own schema, so a step kind added there fails here
  // until this reader knows what it does.
  const source = readFileSync(
    new URL("../../../engine/src/workflows/types.ts", import.meta.url).pathname,
    "utf8",
  );
  const steps = source.slice(
    source.indexOf("export const RequestStepSchema"),
    source.indexOf("export const StepSchema"),
  );
  const kinds = [...steps.matchAll(/^ {4}kind: z\.literal\("([a-z_]+)"\)/gm)].map(
    (match) => match[1] ?? "",
  );

  test("the engine's step schema is read", () => {
    expect(kinds).toContain("request");
    expect(kinds).toContain("wait_for_event");
    expect(kinds.length).toBeGreaterThanOrEqual(8);
  });

  test("every kind of the engine's step schema has a word and a reading", () => {
    for (const kind of kinds) {
      expect(workflowStepKindKey(kind), kind).not.toBe("workflow.stepType");
      expect<string>(read({ id: "x", kind }).essence.kind, kind).toBe(kind);
    }
  });
});

describe("extractor transforms", () => {
  // The names of the extractors' config blocks, read from the engine's schema:
  // a renamed or misspelled one here shows nothing, silently.
  const source = readFileSync(
    new URL("../../../engine/src/workflows/types.ts", import.meta.url).pathname,
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
