import { describe, expect, test } from "bun:test";
import {
  definitionKind,
  readStepDefinition,
  requestProtocol,
  stepDefinitionsOf,
  stepEssenceText,
  stepKindKey,
} from "@/features/workflows/model/workflow-steps";
import { block, de, essence, read, UUID } from "@/features/workflows/model/workflow-steps-fixtures";
import { translate } from "@/lib/i18n";

const PLACEHOLDER = ["$", "{input.name}"].join("");

const reference = (path: string) => ["$", `{${path}}`].join("");

const en: Parameters<typeof stepEssenceText>[1] = (key, values) => translate("en", key, values);

describe("step definition", () => {
  test("names a step without an id by its position instead of leaving it blank", () => {
    expect(readStepDefinition({ kind: "request" }, 2).id).toBe("step-3");
  });

  test("a kind this build does not know says nothing it cannot back", () => {
    const definition = read({ id: "x", kind: "future_kind" });
    expect(definition.essence).toEqual({ kind: "other" });
    expect(definition.blocks).toEqual([]);
    expect(essence({ id: "x", kind: "future_kind" })).toBe("");
    expect(stepKindKey({ kind: "future_kind" })).toBe("workflow.stepType");
  });

  test("a request that writes is named as sending, a read stays a query", () => {
    expect(stepKindKey({ kind: "request", writes: true })).toBe("workflow.kind.send");
    expect(stepKindKey({ kind: "request", writes: false })).toBe("workflow.kind.request");
    expect(stepKindKey({ kind: "request", writes: null })).toBe("workflow.kind.request");
  });

  test("a run step finds its version's definition by step key and reads code from it", () => {
    const definitions = stepDefinitionsOf({
      steps: [
        { id: "fetch", kind: "request", method: "GET" },
        { id: "shape", kind: "transform", expression: "return input" },
        { id: "clean", kind: "transform", language: "readability" },
      ],
    });
    const kindOf = (key: string) => {
      const definition = definitions.get(key);
      return stepKindKey(definition ? definitionKind(definition, null) : { kind: "transform" });
    };
    expect(kindOf("shape")).toBe("workflow.kind.code");
    expect(kindOf("clean")).toBe("workflow.kind.transform");
    expect(kindOf("unknown")).toBe("workflow.kind.transform");
    expect(stepDefinitionsOf(null).size).toBe(0);
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
      "Cookie: •••",
    ]);
  });

  test("retries, effect, time limit and error handling are facts", () => {
    expect(read(step).facts).toEqual([
      { labelKey: "workflow.fact.protocol", valueKey: "workflow.via.http" },
      { labelKey: "workflow.fact.retries", value: "2" },
      { labelKey: "catalog.sideEffects", valueKey: "sideEffects.write" },
      { labelKey: "workflow.fact.timeout", value: "30 s" },
      { labelKey: "workflow.fact.onError", valueKey: "workflow.fact.onErrorContinue" },
    ]);
    expect(read({ id: "a", kind: "request", path: "/x", on_error: "fail" }).facts).toEqual([
      { labelKey: "workflow.fact.protocol", valueKey: "workflow.via.http" },
    ]);
  });

  test("a SQL request names its statement and shows it whole", () => {
    const sql = {
      id: "load",
      kind: "request",
      protocol: "sql",
      method: "SELECT",
      connector_id: UUID,
      sql: { query: "\n  SELECT id, name\n  FROM customers\n  WHERE id = $1", params: [42] },
    };
    expect(essence(sql, "Lager-DB")).toBe("SQL · SELECT id, name · Lager-DB");
    const { blocks } = read(sql);
    expect(block(blocks, "workflow.block.sql")?.language).toBe("sql");
    expect(block(blocks, "workflow.block.sql")?.code).toBe(sql.sql.query);
    expect(block(blocks, "workflow.block.sqlParams")?.code).toBe("[\n  42\n]");
    expect(block(blocks, "workflow.block.request")).toBeUndefined();
  });

  test("a GraphQL request shows its query and variables", () => {
    const graphql = {
      id: "issues",
      kind: "request",
      protocol: "graphql",
      connector_id: UUID,
      graphql: { operation: "query", query: "query Issues { issues { id } }", variables: { n: 5 } },
    };
    expect(essence(graphql)).toBe("GraphQL · query Issues { issues { id } }");
    const { blocks } = read(graphql);
    expect(block(blocks, "workflow.block.graphql")?.language).toBe("graphql");
    expect(block(blocks, "workflow.block.variables")?.code).toBe('{\n  "n": 5\n}');
    expect(block(blocks, "workflow.block.request")).toBeUndefined();
    expect(block(blocks, "workflow.block.pagination")).toBeUndefined();
  });

  test("a GraphQL request on a fixed path shows its target and cursor pagination", () => {
    const cursor = {
      connection_path: "user.projectV2.items",
      cursor_variable: "after",
      items_field: "nodes",
      max_pages: 40,
      max_items: 2000,
    };
    const graphql = {
      id: "project_items",
      kind: "request",
      protocol: "graphql",
      method: "GET",
      path: "/graphql",
      connector_id: UUID,
      graphql: {
        operation: "query",
        query: "query Items { viewer { login } }",
        cursor_pagination: cursor,
      },
    };
    const { blocks } = read(graphql);
    expect(block(blocks, "workflow.block.request")?.code).toBe("POST /graphql");
    expect(block(blocks, "workflow.block.pagination")?.code).toBe(JSON.stringify(cursor, null, 2));
    expect(block(blocks, "workflow.block.graphql")?.language).toBe("graphql");
  });

  test("an object-storage request names its key", () => {
    const s3 = {
      id: "store",
      kind: "request",
      protocol: "s3",
      method: "PUT",
      connector_id: UUID,
      s3: { key: "reports/latest.json" },
    };
    expect(essence(s3)).toBe("Speicher · reports/latest.json");
    expect(block(read(s3).blocks, "workflow.block.storage")?.code).toContain("reports/latest.json");
  });

  test("a file-server request names its path and shows its settings", () => {
    const sftp = {
      id: "pull",
      kind: "request",
      protocol: "sftp",
      method: "LIST",
      connector_id: UUID,
      sftp: { path: "inbox/", max_entries: 50 },
    };
    expect(essence(sftp)).toBe("Dateiserver · inbox/");
    expect(read(sftp).facts).toContainEqual({
      labelKey: "workflow.fact.protocol",
      valueKey: "workflow.via.sftp",
    });
    expect(block(read(sftp).blocks, "workflow.block.fileServer")?.code).toContain(
      '"max_entries": 50',
    );
  });

  test("a tool call on a remote server names the tool and shows its arguments", () => {
    const mcp = {
      id: "notify",
      kind: "request",
      protocol: "mcp",
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

  test("a step of the removed loop kind is shown as an unknown step", () => {
    const loop = read({ id: "each", kind: "loop", over: "fetch.data.items", body: ["send"] });
    expect(loop.essence).toEqual({ kind: "other" });
    expect(stepKindKey({ kind: "loop" })).toBe("workflow.stepType");
  });

  test("a model step shows its instruction, the answer shape and its limit", () => {
    const model = {
      id: "summarise",
      kind: "model",
      prompt: "\nSummarise the ticket in two sentences.\nKeep names.",
      system: "You write for support agents.",
      input: { ticket: reference("fetch.data") },
      output_schema: { type: "object", properties: { summary: { type: "string" } } },
      max_output_tokens: 400,
    };
    const definition = read(model);
    expect(definition.essence).toEqual({ kind: "model", prompt: model.prompt });
    expect(essence(model)).toBe("Summarise the ticket in two sentences.");
    expect(essence({ id: "m", kind: "model" })).toBe("KI fragen");
    expect(stepKindKey({ kind: "model" })).toBe("workflow.kind.askAi");
    expect(definition.facts).toEqual([{ labelKey: "workflow.fact.maxOutputTokens", value: "400" }]);
    expect(block(definition.blocks, "workflow.block.prompt")?.code).toBe(model.prompt);
    expect(block(definition.blocks, "workflow.block.system")?.code).toBe(model.system);
    expect(block(definition.blocks, "workflow.block.input")?.language).toBe("json");
    expect(block(definition.blocks, "workflow.block.outputSchema")?.code).toContain("summary");
    expect(read({ id: "m", kind: "model", prompt: "x" }).facts).toEqual([]);
  });

  test("the protocol of a request decides how it is read, not the blocks it carries", () => {
    expect(requestProtocol({ protocol: "sql" })).toBe("sql");
    expect(requestProtocol({ protocol: "ftp" })).toBe("http");
    expect(requestProtocol({ sql: { query: "select 1" } })).toBe("http");
    const stray = read({ id: "a", kind: "request", path: "/x", sql: { query: "select 1" } });
    expect(stray.essence).toEqual({ kind: "request", via: "http", verb: "GET", target: "/x" });
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
    expect(essence({ id: "pause", kind: "wait" })).toBe("Warten");
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
    expect(read(step).facts).toEqual([]);
  });

  test("a transformation names its language and shows the expression whole", () => {
    const expression = `return { id: "${UUID}", at: "2030-08-25T22:00:00.000Z" };`;
    const step = { id: "shape", kind: "transform", expression };
    expect(essence(step)).toBe("JavaScript");
    const code = block(read(step).blocks, "workflow.block.expression");
    expect(code?.language).toBe("javascript");
    expect(code?.code).toBe(expression);
    expect(essence({ id: "md", kind: "transform", language: "html-to-markdown" })).toBe(
      "HTML → Markdown",
    );
  });
});
