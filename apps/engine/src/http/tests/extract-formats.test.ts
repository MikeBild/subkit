import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import {
  buildDocxFixture,
  buildPdfFixture,
  buildPptxFixture,
  buildXlsxFixture,
} from "../../test-helpers/binary-fixtures.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  srv = await createHttpTestServer("extract-formats");
});

afterAll(async () => {
  await srv.cleanup();
});

function authHeaders(contentType: string): HeadersInit {
  return {
    authorization: `Bearer ${srv.apiKey}`,
    "content-type": contentType,
  };
}

describe("/v1/extract file-format matrix", () => {
  test("JSON body → 200 + parsed data", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/extract`, {
      method: "POST",
      headers: authHeaders("application/json"),
      body: JSON.stringify({ hello: "world", n: 42 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { format: string; data: Record<string, unknown> };
    expect(body.format).toBe("json");
    expect(body.data.hello).toBe("world");
    expect(body.data.n).toBe(42);
  });

  test("CSV body → 200 + parsed rows", async () => {
    const csv = "id,name\n1,alice\n2,bob\n";
    const res = await fetch(`${srv.baseUrl}/v1/extract`, {
      method: "POST",
      headers: authHeaders("text/csv"),
      body: csv,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { format: string; data: Array<Record<string, string>> };
    expect(body.format).toBe("csv");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(2);
    expect(body.data[0]?.id).toBe("1");
    expect(body.data[0]?.name).toBe("alice");
    expect(body.data[1]?.name).toBe("bob");
  });

  test("YAML body → 200 + parsed keys", async () => {
    const yaml = "title: demo\ncount: 3\n";
    const res = await fetch(`${srv.baseUrl}/v1/extract`, {
      method: "POST",
      headers: authHeaders("application/yaml"),
      body: yaml,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { format: string; data: Record<string, unknown> };
    expect(body.format).toBe("yaml");
    expect(body.data.title).toBe("demo");
    expect(body.data.count).toBe(3);
  });

  test("XML body → 200 + parsed tree", async () => {
    const xml = `<?xml version="1.0"?><root><item id="1">alpha</item><item id="2">beta</item></root>`;
    const res = await fetch(`${srv.baseUrl}/v1/extract`, {
      method: "POST",
      headers: authHeaders("application/xml"),
      body: xml,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      format: string;
      data: { children: Array<{ name: string }> };
    };
    expect(body.format).toBe("xml");
    expect(body.data.children[0]?.name).toBe("root");
  });

  test("PDF body → 200 + extracted text", async () => {
    const pdf = buildPdfFixture("Hello extract endpoint.");
    const res = await fetch(`${srv.baseUrl}/v1/extract`, {
      method: "POST",
      headers: authHeaders("application/pdf"),
      body: new Uint8Array(pdf),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      format: string;
      pages?: number;
      data: { text: string };
    };
    expect(body.format).toBe("pdf");
    expect(body.pages).toBeGreaterThanOrEqual(1);
    expect(body.data.text).toContain("Hello extract endpoint");
  });

  test("DOCX body → 200 + markdown", async () => {
    const docx = await buildDocxFixture("Doc Heading", "Paragraph text.");
    const res = await fetch(`${srv.baseUrl}/v1/extract`, {
      method: "POST",
      headers: authHeaders(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
      body: new Uint8Array(docx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { format: string; data: { markdown: string } };
    expect(body.format).toBe("docx");
    expect(body.data.markdown).toMatch(/Doc Heading/);
  });

  test("XLSX body → 200 + sheets-as-rows", async () => {
    const xlsx = buildXlsxFixture({
      Demo: [
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ],
    });
    const res = await fetch(`${srv.baseUrl}/v1/extract`, {
      method: "POST",
      headers: authHeaders("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
      body: new Uint8Array(xlsx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      format: string;
      data: { sheets: Record<string, Array<Record<string, unknown>>> };
    };
    expect(body.format).toBe("xlsx");
    expect(body.data.sheets.Demo?.length).toBe(2);
    expect(body.data.sheets.Demo?.[0]?.name).toBe("alice");
  });

  test("PPTX body → 200 + slides", async () => {
    const pptx = await buildPptxFixture(["First slide", "Second slide"]);
    const res = await fetch(`${srv.baseUrl}/v1/extract`, {
      method: "POST",
      headers: authHeaders(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ),
      body: new Uint8Array(pptx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      format: string;
      data: { slides: Array<{ index: number; text: string }> };
    };
    expect(body.format).toBe("pptx");
    expect(body.data.slides.length).toBe(2);
    expect(body.data.slides[0]?.text).toContain("First slide");
  });

  test("octet-stream body → 415 + unsupported_file_format", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/extract`, {
      method: "POST",
      headers: {
        ...(authHeaders("application/octet-stream") as Record<string, string>),
        "x-filename": "blob.bin",
      },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { code: string; details?: { supported?: string[] } };
    expect(body.code).toBe("unsupported_file_format");
    expect(body.details?.supported).toContain("pdf");
    expect(body.details?.supported).toContain("docx");
  });

  test("PDF body without Authorization → 401", async () => {
    const pdf = buildPdfFixture("hidden");
    const res = await fetch(`${srv.baseUrl}/v1/extract`, {
      method: "POST",
      headers: {
        "content-type": "application/pdf",
        "x-filename": "leak.pdf",
      },
      body: new Uint8Array(pdf),
    });
    expect(res.status).toBe(401);
  });

  test("PDF body with invalid bearer → 401", async () => {
    const pdf = buildPdfFixture("hidden");
    const res = await fetch(`${srv.baseUrl}/v1/extract`, {
      method: "POST",
      headers: {
        authorization: "Bearer not-a-real-token",
        "content-type": "application/pdf",
        "x-filename": "leak.pdf",
      },
      body: new Uint8Array(pdf),
    });
    expect(res.status).toBe(401);
  });

  test("PDF success writes an audit_log row scoped to the bearer's tenant", async () => {
    const pdf = buildPdfFixture("Audit trail probe.");
    const res = await fetch(`${srv.baseUrl}/v1/extract`, {
      method: "POST",
      headers: {
        ...(authHeaders("application/pdf") as Record<string, string>),
        "x-filename": "audit-probe.pdf",
      },
      body: new Uint8Array(pdf),
    });
    expect(res.status).toBe(200);

    const rows = await srv.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, srv.tenantId), eq(auditLog.action, "data.exported")))
      .orderBy(desc(auditLog.ts))
      .limit(1);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.tenant_id).toBe(srv.tenantId);
    expect(row.result).toBe("success");
    expect(row.resource_type).toBe("extract");
    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata.format).toBe("pdf");
    expect(metadata.filename).toBe("audit-probe.pdf");
    expect(metadata.request_source).toBeDefined();

    const otherTenantId = "00000000-0000-0000-0000-0000000000aa";
    expect(otherTenantId).not.toBe(srv.tenantId);
    const crossTenantRows = await srv.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, otherTenantId), eq(auditLog.action, "data.exported")));
    expect(crossTenantRows.length).toBe(0);
  });

  test("PDF parse failure writes an audit_log row with result=failure", async () => {
    const truncated = Buffer.concat([
      Buffer.from([0x25, 0x50, 0x44, 0x46]),
      Buffer.from("--garbage--"),
    ]);
    const res = await fetch(`${srv.baseUrl}/v1/extract`, {
      method: "POST",
      headers: {
        ...(authHeaders("application/pdf") as Record<string, string>),
        "x-filename": "broken.pdf",
      },
      body: new Uint8Array(truncated),
    });
    expect(res.status).toBe(400);

    const rows = await srv.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, srv.tenantId), eq(auditLog.action, "data.exported")))
      .orderBy(desc(auditLog.ts))
      .limit(1);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.result).toBe("error");
    expect(row.reason).toBe("parse_failed");
    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata.format).toBe("pdf");
  });
});
