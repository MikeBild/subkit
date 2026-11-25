import { describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { parseFileIdOrThrow } from "../../api/files-schemas.ts";
import { auditLog, files, intakeItems } from "../../db/schema/index.ts";
import { findRetainedFileReferences } from "../../files/reference-protection.ts";
import * as scanner from "../../files/scanner.ts";
import { ctx, issueUserKey, request, setupIntakeHttp } from "./intake-fixtures.ts";

setupIntakeHttp();

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "latin1");

function fileBody(id: string, over: Record<string, unknown> = {}) {
  return {
    client_request_id: id,
    captured_at: "2026-11-21T09:00:00.000Z",
    filename: "quarter.pdf",
    content_type: "application/pdf",
    content_base64: PDF.toString("base64"),
    ...over,
  };
}

type Item = {
  id: string;
  title: string;
  body: string;
  attachment: {
    file_id: string;
    filename: string;
    content_type: string;
    size_bytes: number;
  } | null;
};

describe("POST /v1/intake/items/file", () => {
  test("a PDF becomes an inbox item that carries its file", async () => {
    const res = await request(
      "/v1/intake/items/file",
      "POST",
      fileBody("20000000-0000-4000-8000-000000000001"),
    );
    expect(res.status).toBe(201);
    const item = (await res.json()) as Item;
    expect(item.title).toBe("quarter.pdf");
    expect(item.attachment?.file_id).toMatch(/^fid_/);
    const fileUuid = parseFileIdOrThrow(item.attachment!.file_id);
    expect(item.attachment).toMatchObject({
      filename: "quarter.pdf",
      content_type: "application/pdf",
      size_bytes: PDF.byteLength,
    });
    const [row] = await ctx.db
      .select({ attachment_file_id: intakeItems.attachment_file_id })
      .from(intakeItems)
      .where(and(eq(intakeItems.tenant_id, ctx.tenantId), eq(intakeItems.id, item.id)));
    expect(row?.attachment_file_id).toBe(fileUuid);
    const [file] = await ctx.db
      .select({ status: files.status })
      .from(files)
      .where(and(eq(files.tenant_id, ctx.tenantId), eq(files.id, fileUuid)));
    expect(file?.status).toBe("ready");

    const detail = (await (await request(`/v1/intake/items/${item.id}`, "GET")).json()) as Item;
    expect(detail.attachment?.file_id).toBe(item.attachment!.file_id);
    expect(
      (detail as Item & { original_snapshot: { attachment?: { file_id: string } } })
        .original_snapshot.attachment?.file_id,
    ).toBe(item.attachment!.file_id);

    const download = await request(`/v1/files/${detail.attachment!.file_id}/content`, "GET");
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(PDF)).toBe(true);

    const audits = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "intake_item.collected"),
          eq(auditLog.resource_id, item.id),
        ),
      );
    expect(audits[0]?.metadata).toMatchObject({ attachment_file_id: fileUuid });

    const retained = await findRetainedFileReferences(ctx.db, [
      { id: fileUuid, tenant_id: ctx.tenantId, slug: null },
      { id: "00000000-0000-4000-8000-0000000000bb", tenant_id: ctx.tenantId, slug: null },
    ]);
    expect(retained.has(fileUuid)).toBe(true);
    expect(retained.has("00000000-0000-4000-8000-0000000000bb")).toBe(false);
  });

  test("the same request id replays the item instead of collecting twice", async () => {
    const id = "20000000-0000-4000-8000-000000000001";
    const res = await request("/v1/intake/items/file", "POST", fileBody(id));
    expect(res.status).toBe(201);
    const items = await ctx.db
      .select()
      .from(intakeItems)
      .where(and(eq(intakeItems.tenant_id, ctx.tenantId), eq(intakeItems.client_request_id, id)));
    expect(items).toHaveLength(1);
  });

  test("a CSV keeps its text as the item body", async () => {
    const res = await request(
      "/v1/intake/items/file",
      "POST",
      fileBody("20000000-0000-4000-8000-000000000002", {
        filename: "leads.csv",
        content_type: "text/csv",
        content_base64: Buffer.from("name,mail\nAda,ada@example.test\n").toString("base64"),
      }),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as Item).body).toBe("name,mail\nAda,ada@example.test\n");
  });

  test("a whitespace-only text file keeps its text as body and original", async () => {
    const res = await request(
      "/v1/intake/items/file",
      "POST",
      fileBody("20000000-0000-4000-8000-000000000007", {
        filename: "blank.txt",
        content_type: "text/plain",
        content_base64: Buffer.from(" \t\n \n").toString("base64"),
      }),
    );
    expect(res.status).toBe(201);
    const item = (await res.json()) as Item;
    expect(item.body).toBe(" \t\n \n");
    const detail = (await (await request(`/v1/intake/items/${item.id}`, "GET")).json()) as Item & {
      original_snapshot: { body?: string };
    };
    expect(detail.original_snapshot.body).toBe(" \t\n \n");
  });

  test("a plain-text file over two million characters keeps its whole text", async () => {
    const text = `${"a".repeat(2_030_000)}END`;
    const res = await request(
      "/v1/intake/items/file",
      "POST",
      fileBody("20000000-0000-4000-8000-000000000008", {
        filename: "large.txt",
        content_type: "text/plain",
        content_base64: Buffer.from(text).toString("base64"),
      }),
    );
    expect(res.status).toBe(201);
    const item = (await res.json()) as Item;
    expect(item.body.length).toBe(text.length);
    expect(item.body.endsWith("END")).toBe(true);
    const detail = (await (await request(`/v1/intake/items/${item.id}`, "GET")).json()) as Item & {
      original_snapshot: { body?: string };
    };
    expect(detail.body).toBe(text);
    expect(detail.original_snapshot.body).toBe(text);
  });

  test("a type outside the list, or bytes that lie about their type, are refused", async () => {
    const html = await request(
      "/v1/intake/items/file",
      "POST",
      fileBody("20000000-0000-4000-8000-000000000003", {
        filename: "page.html",
        content_type: "text/html",
        content_base64: Buffer.from("<html></html>").toString("base64"),
      }),
    );
    expect(html.status).toBe(422);
    expect(((await html.json()) as { code: string }).code).toBe("unsupported_file_type");

    const fake = await request(
      "/v1/intake/items/file",
      "POST",
      fileBody("20000000-0000-4000-8000-000000000004", { content_type: "image/png" }),
    );
    expect(fake.status).toBe(422);
    expect(((await fake.json()) as { code: string }).code).toBe("content_type_mismatch");
  });

  test("a file the malware check rejects collects nothing", async () => {
    const spy = spyOn(scanner, "getScanner").mockReturnValue({
      scan: async () => ({ verdict: "infected", engine: "test", signature: "EICAR" }),
    });
    try {
      const res = await request(
        "/v1/intake/items/file",
        "POST",
        fileBody("20000000-0000-4000-8000-000000000005", {
          content_base64: Buffer.from("%PDF-1.4\ninfected\n", "latin1").toString("base64"),
        }),
      );
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe("file_rejected");
    } finally {
      spy.mockRestore();
    }
    const items = await ctx.db
      .select()
      .from(intakeItems)
      .where(
        and(
          eq(intakeItems.tenant_id, ctx.tenantId),
          eq(intakeItems.client_request_id, "20000000-0000-4000-8000-000000000005"),
        ),
      );
    expect(items).toHaveLength(0);
  });

  test("collecting a file needs intake:write", async () => {
    const readerKey = await issueUserKey("intake-file-reader", ["intake:read"]);
    const res = await request(
      "/v1/intake/items/file",
      "POST",
      fileBody("20000000-0000-4000-8000-000000000006"),
      readerKey,
    );
    expect(res.status).toBe(403);
  });
});
