import { describe, expect, test } from "bun:test";
import type { DiscoveredEndpoint, DiscoveryResult } from "../connectors/discovery/types.ts";
import type { GenerationNeed } from "../llm/runtime/generation-abort.ts";
import { selectDiscoveredEndpoints } from "./authoring-endpoint-selection.ts";
import {
  buildUserPrompt,
  formatRegroundedEvidence,
  nextActionsForNeeds,
  planRegrounding,
  REGROUND_ROUTE_CAP,
  rankConnectorCandidates,
  routeMatches,
} from "./authoring-regrounding.ts";

function endpoint(method: string, path: string, extra: Partial<DiscoveredEndpoint> = {}) {
  return {
    method,
    path,
    summary: null,
    description: null,
    operation_id: null,
    scopes: [],
    params: [],
    request_body_schema: null,
    request_content_type: null,
    response_schemas: {},
    pagination_hint: null,
    deprecated: false,
    ...extra,
  } as DiscoveredEndpoint;
}

function index(endpoints: DiscoveredEndpoint[]): DiscoveryResult {
  return {
    source_url: "https://docs.example.test/openapi.json",
    fetched_at: "2026-01-01T00:00:00.000Z",
    strategy: "openapi-direct",
    spec_version: "openapi-3",
    title: null,
    servers: [],
    auth_schemes: [],
    endpoints,
    warnings: [],
  } as unknown as DiscoveryResult;
}

function need(partial: Partial<GenerationNeed> & Pick<GenerationNeed, "kind">): GenerationNeed {
  return { connector_slug: null, method: null, path: null, question: null, ...partial };
}

const MAIL = { id: "c-mail", slug: "mail", base_url: "https://mail.example.test/api" };
const CRM = { id: "c-crm", slug: "crm", base_url: "https://crm.example.test" };

const filler = Array.from({ length: 60 }, (_, i) => endpoint("GET", `/v1/filler/${i}`));
const send = endpoint("POST", "/v1/users/{userId}/messages/send", {
  summary: "Send a message",
  params: [{ name: "userId", in: "path", required: true, type: "string" }],
  request_body_schema: { type: "object", properties: { raw: { type: "string" } } },
  request_content_type: "application/json",
  response_schemas: { "200": { type: "object", properties: { id: { type: "string" } } } },
});

describe("route matching for re-grounding", () => {
  test("templated, concrete and base-prefixed routes match the documented path", () => {
    expect(routeMatches("/v1/users/{userId}/messages/send", "/v1/users/me/messages/send")).toBe(
      true,
    );
    expect(
      routeMatches("/v1/users/{userId}/messages/send", "/api/v1/users/:id/messages/send"),
    ).toBe(true);
    expect(routeMatches("/v1/users/{userId}/messages", "/v1/users/me/messages/send")).toBe(false);
  });
});

describe("planRegrounding", () => {
  const discovered = new Map([[MAIL.id, index([...filler, send])]]);

  test("pins the named route from the full index even when the excerpt omitted it", () => {
    const excerpt = selectDiscoveredEndpoints([...filler, send], "daily digest", 40);
    expect(excerpt).not.toContain(send);
    const plan = planRegrounding({
      needs: [
        need({
          kind: "endpoint_contract",
          connector_slug: "mail",
          method: "POST",
          path: "/v1/users/me/messages/send",
        }),
      ],
      connectors: [MAIL, CRM],
      discoveredById: discovered,
      excerptCap: 40,
    });
    expect(plan.pins.get(MAIL.id)).toEqual([send]);
    expect(plan.unresolved).toEqual([]);
    const pinnedExcerpt = selectDiscoveredEndpoints(
      [...filler, send],
      "daily digest",
      40,
      plan.pins.get(MAIL.id),
    );
    expect(pinnedExcerpt[0]).toBe(send);
    expect(pinnedExcerpt).toHaveLength(40);
    const section = formatRegroundedEvidence({
      connectors: [MAIL],
      pins: plan.pins,
      shapes: [],
      raisedCapSlugs: [],
    });
    expect(section).toContain("`mail` POST /v1/users/{userId}/messages/send");
    expect(section).toContain("userId (path, required, string)");
    expect(section).toContain('"raw"');
    expect(section).toContain("response 200");
  });

  test("raises the route cap only for the connector a pathless need names", () => {
    const plan = planRegrounding({
      needs: [need({ kind: "endpoint_contract", connector_slug: "mail" })],
      connectors: [MAIL, CRM],
      discoveredById: discovered,
      excerptCap: 40,
    });
    expect([...plan.caps.entries()]).toEqual([[MAIL.id, REGROUND_ROUTE_CAP]]);
  });

  test("a connector outside the scope and an unknown route are not re-grounded", () => {
    const plan = planRegrounding({
      needs: [
        need({ kind: "endpoint_contract", connector_slug: "chat", path: "/x" }),
        need({ kind: "response_shape", connector_slug: "mail", method: "GET", path: "/nowhere" }),
      ],
      connectors: [MAIL],
      discoveredById: discovered,
      excerptCap: 40,
    });
    expect(plan.outOfScope.map((n) => n.connector_slug)).toEqual(["chat"]);
    expect(plan.unresolved.map((n) => n.path)).toEqual(["/nowhere"]);
    expect(plan.pins.size).toBe(0);
  });
});

describe("connector choice", () => {
  const candidates = [
    {
      id: "a",
      slug: "mail-sandbox",
      display_name: "Mail sandbox",
      environment: "dev" as const,
      active_prod_approvals: 0,
    },
    {
      id: "b",
      slug: "mail-ops",
      display_name: "Mail ops",
      environment: "prod" as const,
      active_prod_approvals: 3,
    },
    {
      id: "c",
      slug: "mail-legacy",
      display_name: "Mail legacy",
      environment: "prod" as const,
      active_prod_approvals: 0,
    },
  ];

  test("defaults to the production connector with active approvals", () => {
    const ranked = rankConnectorCandidates(candidates);
    expect(ranked.default).toBe("mail-ops");
    expect(ranked.ordered.map((c) => c.slug)).toEqual(["mail-ops", "mail-legacy", "mail-sandbox"]);
  });

  test("no default when production connectors tie", () => {
    expect(
      rankConnectorCandidates([{ ...candidates[1]!, active_prod_approvals: 0 }, candidates[2]!])
        .default,
    ).toBeNull();
  });

  test("builds a prefilled ask_user_choice payload and derives next actions from the needs", () => {
    const needs = [
      need({ kind: "connector_choice", question: "Which mail connector sends the report?" }),
    ];
    const prompt = buildUserPrompt({ needs, candidates, reason: "three mail connectors" });
    expect(prompt.tool).toBe("ask_user_choice");
    expect(prompt.args).toMatchObject({
      question: "Which mail connector sends the report?",
      default: "mail-ops",
    });
    expect((prompt.args.options as unknown[]).length).toBe(3);
    expect(nextActionsForNeeds(needs, prompt)).toEqual(["ask_user_choice", "author_workflow"]);
  });

  test("a user fact without candidates becomes one ask_user_text question", () => {
    const needs = [
      need({ kind: "user_fact", question: "Who receives the report?" }),
      need({ kind: "user_fact", question: "Which time zone applies?" }),
    ];
    const prompt = buildUserPrompt({ needs, candidates: [], reason: "facts" });
    expect(prompt).toEqual({
      tool: "ask_user_text",
      args: { question: "Who receives the report?\nWhich time zone applies?", multiline: true },
    });
  });

  test("evidence needs point to discovery and probing, never a blind retry first", () => {
    expect(
      nextActionsForNeeds(
        [
          need({ kind: "endpoint_contract", connector_slug: "mail", path: "/x" }),
          need({ kind: "response_shape", connector_slug: "mail", path: "/y" }),
        ],
        null,
      ),
    ).toEqual([
      "discover_connector_endpoints",
      "fetch_connector_docs",
      "probe_connector",
      "author_workflow",
    ]);
  });
});
