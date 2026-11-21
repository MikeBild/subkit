import { describe, expect, test } from "bun:test";
import type { Db } from "../../db/client.ts";
import { runDocumentAnalysisFlow } from "./document-analysis.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";

const OPENAPI = JSON.stringify({
  openapi: "3.0.0",
  paths: {
    "/v1/charges": {
      get: { summary: "List charges", responses: { "200": {} } },
      post: { summary: "Create charge", responses: { "200": {} } },
    },
  },
});

const HAR = JSON.stringify({
  log: {
    entries: [
      {
        request: { method: "GET", url: "https://api.example.com/v1/charges", headers: [] },
        response: { status: 200 },
      },
    ],
  },
});

function recordingDb(): { db: Db; audits: Record<string, unknown>[] } {
  const audits: Record<string, unknown>[] = [];
  const db = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        audits.push(row);
        return { onConflictDoNothing: async () => undefined };
      },
    }),
  } as unknown as Db;
  return { db, audits };
}

function attachment(filename: string, content: string) {
  return { storage_uri: `memory://${filename}`, mime_type: "application/json", filename, content };
}

describe("runDocumentAnalysisFlow", () => {
  test("an OpenAPI document is parsed without the model at confidence 95", async () => {
    const { db, audits } = recordingDb();
    const result = await runDocumentAnalysisFlow({
      tenant_id: TENANT,
      db,
      attachments: [attachment("stripe.json", OPENAPI)],
    });
    expect(result.errors).toEqual([]);
    expect(result.source_format).toBe("openapi");
    expect(result.confidence).toBe(95);
    expect(result.endpoints.map((e) => `${e.method} ${e.path}`).sort()).toEqual([
      "GET /v1/charges",
      "POST /v1/charges",
    ]);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.result).toBe("success");
  });

  test("a HAR capture is detected from its content at confidence 98", async () => {
    const { db } = recordingDb();
    const result = await runDocumentAnalysisFlow({
      tenant_id: TENANT,
      db,
      attachments: [attachment("capture.json", HAR)],
    });
    expect(result.source_format).toBe("har");
    expect(result.confidence).toBe(98);
    expect(result.endpoints).toHaveLength(1);
  });

  test("the same endpoint in two attachments is kept once", async () => {
    const { db } = recordingDb();
    const result = await runDocumentAnalysisFlow({
      tenant_id: TENANT,
      db,
      attachments: [attachment("a.json", OPENAPI), attachment("b.json", OPENAPI)],
    });
    expect(result.endpoints.filter((e) => e.method === "GET")).toHaveLength(1);
    expect(result.endpoints).toHaveLength(2);
  });

  test("an unreadable document is reported and lowers the confidence", async () => {
    const { db, audits } = recordingDb();
    const result = await runDocumentAnalysisFlow({
      tenant_id: TENANT,
      db,
      attachments: [{ ...attachment("scan.pdf", ""), mime_type: "application/pdf" }],
    });
    expect(result.source_format).toBe("pdf");
    expect(result.confidence).toBe(60);
    expect(result.errors).toHaveLength(1);
    expect(audits[0]?.result).toBe("error");
  });
});
