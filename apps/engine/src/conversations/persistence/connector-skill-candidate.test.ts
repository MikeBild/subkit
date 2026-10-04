import { describe, expect, test } from "bun:test";
import type { RemoteToolDescriptor } from "../../mcp/client/manifest.ts";
import {
  buildConnectorCapabilitySignal,
  type ConnectorCapabilityInput,
  extractDataPaths,
  extractPagingHints,
} from "./connector-skill-candidate.ts";

const METABASE_TOOLS: RemoteToolDescriptor[] = [
  {
    name: "search",
    description:
      'Search for tables, models, metrics, saved questions, dashboards, and collections in Metabase. Use term_queries for keyword search or semantic_queries for natural language search. Both arguments are arrays of strings, for example term_queries: ["orders", "revenue"].',
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_resource",
    description:
      "Read Metabase entities by metabase:// URI. Examples: metabase://databases, metabase://database/{id}/tables, metabase://collection/{id}/items, metabase://question/{id}, metabase://dashboard/{id}/items, metabase://table/{id}/fields. Up to 5 URIs per call. List endpoints cap at 25 items.",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "execute_sql",
    description:
      "Execute a raw SQL query against a Metabase-connected database. Use this ONLY when MBQL via construct_query cannot express the question. See https://www.metabase.com/docs/latest/?token=abc for details.",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "query",
    description:
      "Execute a Metabase query and return results with column metadata, paginating automatically up to 2,000 rows total.\n\nResults are returned in pages of 200 rows. When more pages remain within the 2,000-row budget, the response includes a continuation_token — pass it back to fetch the next page.",
    inputSchema: { type: "object" },
  },
  {
    name: "create_question",
    description: "Save a query as a named question in Metabase.",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: false },
  },
];

function input(overrides: Partial<ConnectorCapabilityInput> = {}): ConnectorCapabilityInput {
  return {
    connector: {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "metabase-reporting-mcp",
      display_name: "metabase-reporting-mcp",
      base_url: "https://metabase.example.test/api/mcp?api_key=mb_live_abcdef0123456789",
      auth_type: "bearer",
    },
    purpose: "Reporting over our Metabase instance.",
    manifest: {
      tools: METABASE_TOOLS,
      instructions: "Start with metabase://databases to find a database id.",
    },
    ...overrides,
  };
}

describe("extractDataPaths", () => {
  test("names every scheme:// path in the descriptions, never a web URL", () => {
    expect(extractDataPaths(METABASE_TOOLS)).toEqual([
      "metabase://collection/{id}/items",
      "metabase://dashboard/{id}/items",
      "metabase://database/{id}/tables",
      "metabase://databases",
      "metabase://question/{id}",
      "metabase://table/{id}/fields",
    ]);
  });
});

describe("extractDataPaths keeps no credential", () => {
  test("drops the user:password part of an address a description names", () => {
    const paths = extractDataPaths([
      {
        ...METABASE_TOOLS[0]!,
        description:
          "Reads postgres://admin:Hunter2pass@db.internal/prod and redis://:s3cr3tpw@cache:6379.",
      },
    ]);
    expect(paths).toEqual(["postgres://db.internal/prod", "redis://cache:6379"]);
    expect(paths.join(" ")).not.toMatch(/Hunter2pass|s3cr3tpw/);
  });
});

describe("extractPagingHints", () => {
  test("keeps the sentences about caps and pages, attributed to their tool", () => {
    const hints = extractPagingHints(METABASE_TOOLS);
    expect(hints).toContain("read_resource: List endpoints cap at 25 items.");
    expect(hints.some((h) => h.startsWith("query:") && h.includes("pages of 200 rows"))).toBe(true);
    expect(hints.some((h) => h.includes("continuation_token"))).toBe(true);
  });
});

describe("buildConnectorCapabilitySignal", () => {
  test("a connector-scoped candidate naming tools, claims, data paths and paging", () => {
    const signal = buildConnectorCapabilitySignal(input());
    expect(signal).toMatchObject({
      pattern_kind: "connector_capability",
      scope: "connector",
      connector_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(signal.endpoint_key).toBeUndefined();
    const firstLine = signal.body.split("\n")[0] ?? "";
    expect(firstLine).toStartWith("Start at `metabase://databases`, follow the ids it returns");
    expect(firstLine).toContain("lists are paged");
    expect(firstLine.length).toBeLessThanOrEqual(120);
    expect(signal.title).toBe("Navigating the 'metabase-reporting-mcp' MCP server");
    expect(signal.body).toContain("at metabase.example.test");
    expect(signal.body).toContain("`metabase://databases`");
    expect(signal.body).toContain("`metabase://database/{id}/tables`");
    expect(signal.body).toContain("- read_resource (reads)");
    expect(signal.body).toContain("- create_question (writes)");
    expect(signal.body).toContain("- query (no read/write claim)");
    expect(signal.body).toContain("List endpoints cap at 25 items.");
    expect(signal.body).toContain(
      'Server instructions (quoted from the server, unverified): "Start with metabase://databases',
    );
    expect(signal.body).toContain("listed 5 tool(s)");
    expect(signal.body).toContain("Purpose: Reporting over our Metabase instance.");
  });

  test("carries no secret material: no base_url path or query, no sign-in value", () => {
    const signal = buildConnectorCapabilitySignal(input());
    expect(signal.body).not.toContain("mb_live_");
    expect(signal.body).not.toContain("api_key");
    expect(signal.body).not.toContain("/api/mcp");
    expect(signal.body).not.toContain("token=abc");
    expect(signal.body).toContain("Sign-in: bearer");
  });

  test("the fingerprint is stable across catalog order and changes with the catalog", () => {
    const a = buildConnectorCapabilitySignal(input());
    const reordered = buildConnectorCapabilitySignal(
      input({
        manifest: {
          tools: [...METABASE_TOOLS].reverse(),
          instructions: "Start with metabase://databases to find a database id.",
        },
      }),
    );
    expect(reordered.fingerprint).toBe(a.fingerprint);
    expect(reordered.body).toBe(a.body);

    const fewer = buildConnectorCapabilitySignal(
      input({ manifest: { tools: METABASE_TOOLS.slice(0, 2), instructions: null } }),
    );
    expect(fewer.fingerprint).not.toBe(a.fingerprint);

    const otherConnector = buildConnectorCapabilitySignal(
      input({
        connector: { ...input().connector, id: "22222222-2222-4222-8222-222222222222" },
      }),
    );
    expect(otherConnector.fingerprint).not.toBe(a.fingerprint);
  });

  test("evidence carries no timing, so a re-probe never adds an evidence row", () => {
    const signal = buildConnectorCapabilitySignal(input());
    expect(signal.evidence).toEqual([
      {
        evidence_type: "connector_probe_manifest",
        summary: "Green MCP handshake listed 5 tool(s) for connector 'metabase-reporting-mcp'.",
      },
    ]);
  });

  test("the body stays within the skill size cap for a large catalog", () => {
    const many: RemoteToolDescriptor[] = Array.from({ length: 80 }, (_, i) => ({
      name: `tool_${String(i).padStart(2, "0")}`,
      description: `Tool ${i} reads app://thing/${i} and returns results in pages of 50. ${"x".repeat(300)}`,
      inputSchema: { type: "object" },
    }));
    const signal = buildConnectorCapabilitySignal(
      input({ manifest: { tools: many, instructions: "y".repeat(5_000) } }),
    );
    expect(signal.body.length).toBeLessThanOrEqual(4_000);
    expect(signal.body).toMatch(/- … and \d+ more\n/);
    expect(signal.body).toContain("`app://thing/0`");
    expect(signal.body).toContain("Paging, as the tool descriptions state it");
    expect(signal.body).toContain("listed 80 tool(s)");
  });
});
