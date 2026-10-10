import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { files } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  srv = await createHttpTestServer("files-concurrency");
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 30_000);

describe("files inline upload — concurrent dedup", () => {
  test("two parallel POSTs of same sha256: both resolve to same fid, only one row", async () => {
    const content = "concurrent-dedup-bytes-unique-12345";
    const b64 = Buffer.from(content).toString("base64");
    const body = JSON.stringify({
      filename: "concurrent.txt",
      content_type: "text/plain",
      content_base64: b64,
    });

    const post = () =>
      fetch(`${srv.baseUrl}/v1/files/inline`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${srv.apiKey}`,
          "content-type": "application/json",
          connection: "close",
        },
        body,
      });

    const [r1, r2] = await Promise.all([post(), post()]);

    expect([200, 201]).toContain(r1.status);
    expect([200, 201]).toContain(r2.status);

    const j1 = (await r1.json()) as { id: string };
    const j2 = (await r2.json()) as { id: string };

    expect(j1.id).toBe(j2.id);
    expect(j1.id).toMatch(/^fid_/);

    const sha256 = createHash("sha256").update(content).digest("hex");
    const rows = await srv.db
      .select({ n: count() })
      .from(files)
      .where(and(eq(files.tenant_id, srv.tenantId), eq(files.sha256, sha256)));
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

describe("files inline upload — concurrent restoration", () => {
  test.each([false, true])(
    "parallel restoration preserves the canonical file; occupied slug: %s",
    async (occupiedSlug) => {
      const content = `concurrent-restore-bytes-unique-${occupiedSlug}`;
      const headers = {
        authorization: `Bearer ${srv.apiKey}`,
        "content-type": "application/json",
        connection: "close",
      };
      const post = () =>
        fetch(`${srv.baseUrl}/v1/files/inline`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            filename: `restore-${occupiedSlug}.txt`,
            content_type: "text/plain",
            content_base64: Buffer.from(content).toString("base64"),
          }),
        });
      const initial = await post();
      expect(initial.status).toBe(201);
      const original = (await initial.json()) as { id: string };
      const removed = await fetch(`${srv.baseUrl}/v1/files/${original.id}`, {
        method: "DELETE",
        headers,
      });
      expect(removed.status).toBe(204);
      if (occupiedSlug) {
        const replacement = await fetch(`${srv.baseUrl}/v1/files/inline`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            filename: `restore-${occupiedSlug}.txt`,
            content_type: "text/plain",
            content_base64: Buffer.from("replacement-content").toString("base64"),
          }),
        });
        expect(replacement.status).toBe(201);
        await replacement.arrayBuffer();
      }
      const [first, second] = await Promise.all([post(), post()]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstFile = (await first.json()) as { id: string; slug: string };
      const secondFile = (await second.json()) as { id: string; slug: string };
      expect(firstFile.id).toBe(original.id);
      expect(secondFile.id).toBe(original.id);
      expect(firstFile.slug).toBe(secondFile.slug);
      expect(firstFile.slug).toBe(`restore-${occupiedSlug}${occupiedSlug ? "-2" : ""}`);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const restored = await srv.db
        .select({ deleted_at: files.deleted_at })
        .from(files)
        .where(and(eq(files.tenant_id, srv.tenantId), eq(files.sha256, sha256)));
      expect(restored).toHaveLength(1);
      expect(restored[0]?.deleted_at).toBeNull();
    },
  );
});
