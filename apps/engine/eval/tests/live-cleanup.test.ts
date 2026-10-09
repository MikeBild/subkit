import { describe, expect, test } from "bun:test";
import { deleteArtifacts, type EngineClient } from "../live-authoring.ts";
import {
  artifactsFromToolResult,
  type CreatedArtifact,
  collectCreatedArtifacts,
  deletionOrder,
  EVAL_LIVE_TITLE_PREFIX,
  type ObservedToolCall,
  type ScenarioObservation,
} from "../live-report.ts";
import { renderSweepTable, type SweepListing, sweepPlan } from "../live-sweep.ts";

function call(tool: string, output: unknown, call_id = `${tool}_1`): ObservedToolCall {
  return { tool, input: {}, output, call_id };
}

function observation(over: Partial<ScenarioObservation>): ScenarioObservation {
  return {
    scenario: "s",
    tool_calls: 0,
    results: [],
    turns: [],
    committed_workflow_id: null,
    created_artifacts: [],
    status: "committed",
    wall_ms: 1,
    ...over,
  };
}

describe("artifactsFromToolResult", () => {
  test("save_workflow_draft: committed_workflow_id, workflow_id or draft_target.id with the slug", () => {
    expect(
      artifactsFromToolResult(
        call("save_workflow_draft", {
          ok: true,
          data: { workflow_id: "wf_a", slug: "berlin-weather", draft_target: { id: "wf_a" } },
          committed_workflow_id: "wf_a",
        }),
      ),
    ).toEqual([{ kind: "workflow", id: "wf_a", slug: "berlin-weather" }]);
    expect(
      artifactsFromToolResult(
        call("save_workflow_draft", {
          ok: true,
          data: { draft_target: { id: "wf_b", slug: "b" } },
        }),
      ),
    ).toEqual([{ kind: "workflow", id: "wf_b", slug: "b" }]);
    expect(artifactsFromToolResult(call("save_workflow_draft", { ok: false }))).toEqual([]);
  });

  test("create_knowledge_source and save_connector_draft name their created rows", () => {
    expect(
      artifactsFromToolResult(
        call("create_knowledge_source", {
          ok: true,
          data: { created: true, knowledge_source: { id: "ks_1", name: "n", slug: "n" } },
        }),
      ),
    ).toEqual([{ kind: "knowledge_source", id: "ks_1", slug: "n" }]);
    expect(
      artifactsFromToolResult(
        call("save_connector_draft", {
          ok: true,
          data: { connector: { id: "cn_1", slug: "open-meteo" } },
        }),
      ),
    ).toEqual([{ kind: "connector", id: "cn_1", slug: "open-meteo" }]);
  });

  test("read tools never yield artifacts", () => {
    expect(artifactsFromToolResult(call("list_connectors", { items: [{ id: "x" }] }))).toEqual([]);
  });
});

describe("collectCreatedArtifacts", () => {
  test("merges created_resources, committed_workflow_id and tool results, dedups and keeps the slug", () => {
    const artifacts = collectCreatedArtifacts(
      observation({
        created_artifacts: [
          { kind: "conversation", id: "conv_1" },
          { kind: "workflow", id: "wf_a" },
        ],
        committed_workflow_id: "wf_a",
        results: [
          call("save_connector_draft", {
            ok: true,
            data: { connector: { id: "cn_1", slug: "c" } },
          }),
          call("create_knowledge_source", {
            ok: true,
            data: { knowledge_source: { id: "ks_1" } },
          }),
          call("save_workflow_draft", { ok: true, data: { workflow_id: "wf_a", slug: "wf-a" } }),
        ],
      }),
    );
    expect(artifacts).toEqual([
      { kind: "workflow", id: "wf_a", slug: "wf-a" },
      { kind: "knowledge_source", id: "ks_1" },
      { kind: "connector", id: "cn_1", slug: "c" },
      { kind: "conversation", id: "conv_1" },
    ]);
  });

  test("an observation without writes yields only its conversation", () => {
    expect(
      collectCreatedArtifacts(
        observation({
          created_artifacts: [{ kind: "conversation", id: "conv_2" }],
          results: [call("ask_user_text", { ok: true })],
        }),
      ),
    ).toEqual([{ kind: "conversation", id: "conv_2" }]);
  });
});

describe("deletionOrder", () => {
  test("workflow → knowledge_source → connector → conversation, stable within a kind", () => {
    const ordered = deletionOrder([
      { kind: "conversation", id: "c1" },
      { kind: "connector", id: "n1" },
      { kind: "workflow", id: "w2" },
      { kind: "knowledge_source", id: "k1" },
      { kind: "workflow", id: "w1" },
      { kind: "conversation", id: "c0" },
    ]);
    expect(ordered.map((a) => `${a.kind}:${a.id}`)).toEqual([
      "workflow:w2",
      "workflow:w1",
      "knowledge_source:k1",
      "connector:n1",
      "conversation:c1",
      "conversation:c0",
    ]);
  });
});

describe("sweepPlan", () => {
  const listing: SweepListing = {
    conversations: [
      { id: "c_eval", title: `${EVAL_LIVE_TITLE_PREFIX}berlin-weather-summary` },
      { id: "c_user", title: "eval-live-ish but mine" },
      { id: "c_null", title: null },
    ],
    workflows: [
      { id: "w1", slug: "berlin-weather-tomorrow" },
      { id: "w2", slug: "berlin-weather-by-date" },
      { id: "w3", slug: "berlin-weather-tomorrow-prod" },
    ],
    connectors: [
      { id: "n1", slug: "open-meteo-weather" },
      { id: "n2", slug: "open-meteo" },
    ],
  };

  test("exact slugs and the title prefix select rows, in deletion order", () => {
    const plan = sweepPlan(listing, {
      titlePrefix: EVAL_LIVE_TITLE_PREFIX,
      workflowSlugs: ["berlin-weather-tomorrow", "berlin-weather-by-date"],
      connectorSlugs: ["open-meteo-weather"],
    });
    expect(plan).toEqual([
      { kind: "workflow", id: "w1", slug: "berlin-weather-tomorrow" },
      { kind: "workflow", id: "w2", slug: "berlin-weather-by-date" },
      { kind: "connector", id: "n1", slug: "open-meteo-weather" },
      {
        kind: "conversation",
        id: "c_eval",
        slug: `${EVAL_LIVE_TITLE_PREFIX}berlin-weather-summary`,
      },
    ]);
  });

  test("an empty title prefix matches no conversation and empty slug lists match nothing", () => {
    expect(sweepPlan(listing, { titlePrefix: "", workflowSlugs: [], connectorSlugs: [] })).toEqual(
      [],
    );
    expect(
      sweepPlan(listing, {
        titlePrefix: EVAL_LIVE_TITLE_PREFIX,
        workflowSlugs: [""],
        connectorSlugs: [],
      }),
    ).toEqual([
      {
        kind: "conversation",
        id: "c_eval",
        slug: `${EVAL_LIVE_TITLE_PREFIX}berlin-weather-summary`,
      },
    ]);
  });

  test("renderSweepTable prints one row per artifact and a placeholder for an empty plan", () => {
    const table = renderSweepTable([
      { kind: "workflow", id: "w1", slug: "berlin-weather-tomorrow" },
      { kind: "conversation", id: "c_eval" },
    ]);
    expect(table.split("\n")).toHaveLength(4);
    expect(table).toContain("berlin-weather-tomorrow");
    expect(renderSweepTable([])).toBe("(nothing to sweep)");
  });
});

describe("deleteArtifacts", () => {
  function fakeClient(
    respond: (path: string, attempt: number) => Response,
  ): EngineClient & { calls: string[] } {
    const attempts = new Map<string, number>();
    const calls: string[] = [];
    return {
      engine_url: "http://engine.test",
      calls,
      async request(path, init) {
        const n = (attempts.get(path) ?? 0) + 1;
        attempts.set(path, n);
        calls.push(`${init?.method ?? "GET"} ${path}`);
        return respond(path, n);
      },
    };
  }

  const ARTIFACTS: CreatedArtifact[] = [
    { kind: "conversation", id: "c1" },
    { kind: "workflow", id: "w1", slug: "w" },
    { kind: "connector", id: "n1" },
    { kind: "knowledge_source", id: "k1" },
  ];

  test("deletes in dependency order against the id-addressed routes; 204 and 404 both count as gone", () => {
    const client = fakeClient((path) =>
      path.includes("/connectors/")
        ? new Response(null, { status: 404 })
        : new Response(null, { status: 204 }),
    );
    return deleteArtifacts(client, ARTIFACTS).then((result) => {
      expect(client.calls).toEqual([
        "DELETE /v1/workflows/w1",
        "DELETE /v1/knowledge-sources/k1",
        "DELETE /v1/connectors/n1",
        "DELETE /v1/conversations/c1",
      ]);
      expect(result.deleted).toHaveLength(4);
      expect(result.failures).toEqual([]);
    });
  });

  test("a 409 (turn still running) is retried and succeeds on a later attempt", async () => {
    const client = fakeClient((path, attempt) =>
      path.includes("/conversations/") && attempt < 3
        ? new Response(JSON.stringify({ code: "turn_running" }), { status: 409 })
        : new Response(null, { status: 204 }),
    );
    const result = await deleteArtifacts(client, [{ kind: "conversation", id: "c1" }], {
      retryDelayMs: 0,
    });
    expect(client.calls).toHaveLength(3);
    expect(result.deleted).toEqual([{ kind: "conversation", id: "c1" }]);
    expect(result.failures).toEqual([]);
  });

  test("a persistent 409 and a 500 are reported as failures that name the artifact", async () => {
    const client = fakeClient((path) =>
      path.includes("/conversations/")
        ? new Response("busy", { status: 409 })
        : new Response("boom", { status: 500 }),
    );
    const result = await deleteArtifacts(
      client,
      [
        { kind: "conversation", id: "c1" },
        { kind: "workflow", id: "w1", slug: "w" },
      ],
      { retryDelayMs: 0 },
    );
    expect(result.deleted).toEqual([]);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toContain("workflow:w1 (w)");
    expect(result.failures[0]).toContain("500");
    expect(result.failures[1]).toContain("conversation:c1");
    expect(result.failures[1]).toContain("409");
    expect(client.calls.filter((c) => c.includes("/workflows/"))).toHaveLength(1);
    expect(client.calls.filter((c) => c.includes("/conversations/"))).toHaveLength(3);
  });

  test("a thrown fetch error is a failure, not a crash", async () => {
    const client: EngineClient = {
      engine_url: "http://engine.test",
      request: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    };
    const result = await deleteArtifacts(client, [{ kind: "workflow", id: "w1" }]);
    expect(result.failures).toEqual(["DELETE workflow:w1 → connect ECONNREFUSED"]);
  });
});
