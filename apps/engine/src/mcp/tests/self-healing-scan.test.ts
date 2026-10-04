import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { selfHealingScans } from "../../db/schema/index.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
let prevMode: string | undefined;

beforeAll(async () => {
  prevMode = process.env.SK_MCP_MODE;
  process.env.SK_MCP_MODE = "admin";
  suite = await startMcpTestSuite("self-healing-scan");
});

afterAll(async () => {
  await suite.cleanup();
  if (prevMode === undefined) delete process.env.SK_MCP_MODE;
  else process.env.SK_MCP_MODE = prevMode;
});

describe("mcp self_healing_scan tool", () => {
  test("appears in tools/list under admin mode", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("self_healing_scan");
  });

  test("tools/call runs a scan and persists the self_healing_scans row", async () => {
    const client = await suite.connect();
    const callResult = await client.callTool({
      name: "self_healing_scan",
      arguments: {},
    });
    expect(callResult.isError ?? false).toBe(false);
    const content = callResult.content as Array<{ type: string; text: string }>;
    expect(Array.isArray(content)).toBe(true);
    const payload = JSON.parse(content[0]?.text ?? "{}") as {
      scan_id: string;
      signals_detected: number;
      candidates_created: number;
      unanchored_detected: number;
      candidates: unknown[];
      unanchored: unknown[];
    };
    expect(payload.scan_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.signals_detected).toBe(0);
    expect(payload.candidates_created).toBe(0);
    expect(payload.unanchored_detected).toBe(0);
    expect(payload.candidates).toEqual([]);
    expect(payload.unanchored).toEqual([]);

    const rows = await suite.http.db
      .select()
      .from(selfHealingScans)
      .where(eq(selfHealingScans.id, payload.scan_id));
    expect(rows.length).toBe(1);
    expect(rows[0]?.source).toBe("mcp");
    expect(rows[0]?.status).toBe("succeeded");
    expect(rows[0]?.tenant_id).toBe(suite.http.tenantId);
  });
});
