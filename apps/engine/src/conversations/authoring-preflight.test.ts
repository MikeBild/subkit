import { describe, expect, test } from "bun:test";
import type { DiscoveredEndpoint, DiscoveryResult } from "../connectors/discovery/types.ts";
import type { GroundedConnector } from "./authoring-grounding.ts";
import {
  type ConnectorPreflightArgs,
  probeableGoalEndpoints,
  runConnectorPreflights,
} from "./authoring-preflight.ts";
import type { ToolContext } from "./tools/index.ts";

const ctx = {
  tenant_id: "00000000-0000-4000-8000-000000000001",
  conversation_id: "00000000-0000-4000-8000-000000000002",
} as unknown as ToolContext;

function connector(id: string, slug: string): GroundedConnector {
  return {
    id,
    slug,
    display_name: slug,
    driver: "http",
    base_url: `https://${slug}.preflight.test`,
    auth_type: "none",
    description: null,
    self_description: null,
  };
}

function endpoint(partial: Partial<DiscoveredEndpoint> & { path: string }): DiscoveredEndpoint {
  return {
    method: "GET",
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
    ...partial,
  };
}

function index(endpoints: DiscoveredEndpoint[]): DiscoveryResult {
  return {
    source_url: "https://preflight.test/openapi.json",
    fetched_at: "2026-01-01T00:00:00.000Z",
    strategy: "openapi-direct",
    spec_version: "openapi-3",
    title: null,
    servers: [],
    auth_schemes: [],
    endpoints,
    warnings: [],
  };
}

const CRM = connector("00000000-0000-4000-8000-0000000000a1", "crm");
const MAILER = connector("00000000-0000-4000-8000-0000000000a2", "mailer");

describe("runConnectorPreflights", () => {
  test("runs the pre-flight once per connector and keeps only non-empty indexes", async () => {
    const calls: string[] = [];
    const out = await runConnectorPreflights({
      ctx,
      goal: "list contacts",
      connectors: [CRM, MAILER],
      signal: new AbortController().signal,
      preflight: async ({ connector: c }: ConnectorPreflightArgs) => {
        calls.push(c.id);
        return c.id === CRM.id ? index([endpoint({ path: "/contacts" })]) : index([]);
      },
    });
    expect(calls.sort()).toEqual([CRM.id, MAILER.id].sort());
    expect([...out.keys()]).toEqual([CRM.id]);
  });

  test("is bounded by its signal even when a connector never answers", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const out = await runConnectorPreflights({
      ctx,
      goal: "list contacts",
      connectors: [CRM, MAILER],
      signal: controller.signal,
      preflight: ({ connector: c }: ConnectorPreflightArgs) => {
        started.push(c.id);
        if (started.length === 2) controller.abort();
        return new Promise<DiscoveryResult | null>(() => {});
      },
    });
    expect(started).toHaveLength(2);
    expect(out.size).toBe(0);
  });

  test("a failing pre-flight is skipped without failing the others", async () => {
    const out = await runConnectorPreflights({
      ctx,
      goal: "list contacts",
      connectors: [CRM, MAILER],
      signal: new AbortController().signal,
      preflight: async ({ connector: c }: ConnectorPreflightArgs) => {
        if (c.id === MAILER.id) throw new Error("spec unreachable");
        return index([endpoint({ path: "/contacts" })]);
      },
    });
    expect([...out.keys()]).toEqual([CRM.id]);
  });

  test("an already aborted signal runs nothing to completion", async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await runConnectorPreflights({
      ctx,
      goal: "list contacts",
      connectors: [CRM],
      signal: controller.signal,
      preflight: async () => index([endpoint({ path: "/contacts" })]),
    });
    expect(out.size).toBe(0);
  });
});

describe("probeableGoalEndpoints", () => {
  test("keeps only parameter-free GET routes that match the goal", () => {
    const picked = probeableGoalEndpoints(
      "show all contacts",
      [
        endpoint({ path: "/contacts", summary: "List contacts" }),
        endpoint({ method: "POST", path: "/contacts", summary: "Create a contact" }),
        endpoint({ path: "/contacts/{id}", summary: "Get a contact" }),
        endpoint({
          path: "/contacts/search",
          summary: "Search contacts",
          params: [{ name: "q", in: "query", required: true, type: "string" }],
        }),
        endpoint({ path: "/legacy/contacts", summary: "List contacts", deprecated: true }),
        endpoint({ path: "/invoices", summary: "List invoices" }),
      ],
      2,
    );
    expect(picked.map((e) => `${e.method} ${e.path}`)).toEqual(["GET /contacts"]);
  });
});
