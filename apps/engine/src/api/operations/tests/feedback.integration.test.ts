import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  files,
  httpRateLimitBuckets,
  intakeItems,
  users,
} from "../../../db/schema/index.ts";
import { createFeedbackRateLimiter } from "../../../feedback/rate-limit.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  type HttpTestServer,
} from "../../../http/tests/setup.ts";
import { getObjectStore } from "../../../storage/object-store.ts";
import { pinAdmissionClock } from "../../../test-helpers/pinned-admission-clock.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { resetFeedbackRateLimiter } from "../feedback.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64");

let ctx: HttpTestServer;
let member: Record<string, string>;
let memberId: string;

async function post(body: unknown, headers: Record<string, string> = member) {
  const res = await fetch(`${ctx.baseUrl}/v1/feedback`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function itemOf(id: unknown) {
  const [row] = await ctx.db
    .select()
    .from(intakeItems)
    .where(and(eq(intakeItems.tenant_id, ctx.tenantId), eq(intakeItems.id, String(id))));
  if (!row) throw new Error("intake item missing");
  return row;
}

async function storedText(fileId: string): Promise<string> {
  const [row] = await ctx.db.select().from(files).where(eq(files.id, fileId));
  if (!row) throw new Error("file missing");
  const key = row.storage_uri.replace(/^[a-z0-9]+:\/\/[^/]+\//, "");
  return (await getObjectStore().get(key)).toString("utf8");
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_feedback");
  const [row] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member-feedback@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!row) throw new Error("member insert failed");
  memberId = row.id;
  member = await browserSessionHeaders(ctx, memberId);
});

beforeEach(async () => {
  resetFeedbackRateLimiter();
  await ctx.db.delete(httpRateLimitBuckets);
});

afterAll(async () => {
  resetFeedbackRateLimiter();
  await ctx.cleanup();
});

describe("POST /v1/feedback", () => {
  test("a member without any permission files a cleaned report in the workspace intake", async () => {
    const res = await post({
      kind: "bug",
      message:
        "Save does nothing\nAuthorization: Bearer abcdefgh12345678\nsee https://subkit.example.test/x?token=zzz and /Users/alex/notes.txt",
      diagnostics: {
        app_version: "0.1.0",
        platform: "darwin 25.0 arm64",
        client_kind: "desktop",
        server_version: "11.1.0",
        connection: "connected as alex@example.test",
        route: "/cockpit/files?download=1",
        recent_errors: [
          { code: "cockpit.load: ENOENT /Users/alex/x.json", at: "2026-11-20T10:00:00.000Z" },
        ],
      },
      attachments: [
        { filename: "/Users/alex/log.txt", content_base64: b64("password=hunter2222\nok") },
      ],
      screenshot_png_base64: b64(PNG),
    });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(["id", "intake_item_id"]);

    const item = await itemOf(res.body.intake_item_id);
    expect(item.category).toBe("feedback");
    expect(item.state).toBe("collected");
    expect(item.title).toBe("Bug report: Save does nothing");
    expect(item.client_request_id).toBe(String(res.body.id));
    expect(item.collected_by_id).toBe(memberId);
    expect(item.original_snapshot.origin).toBe("note");
    for (const leaked of [
      "abcdefgh12345678",
      "token=zzz",
      "/Users/alex",
      "alex@example.test",
      "download=1",
    ])
      expect(item.body).not.toContain(leaked);
    expect(item.body).toContain("Authorization: [removed]");
    expect(item.body).toContain("https://subkit.example.test/x and [path]");
    expect(item.body).toContain("- Connection: connected as [email]");
    expect(item.body).toContain("- Route: /cockpit/files");
    expect(item.body).toContain("2026-11-20T10:00:00.000Z cockpit.load: ENOENT [path]");
    expect(item.body).toContain("- log.txt (text/plain,");
    expect(item.body).toContain("- window-screenshot.png (image/png, 12 B)");

    const [audit] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, "feedback.submitted")));
    expect(audit?.resource_type).toBe("intake_item");
    expect(audit?.resource_id).toBe(item.id);
    expect(audit?.actor_id).toBe(memberId);
    const metadata = audit?.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      kind: "bug",
      report_id: String(res.body.id),
      client_kind: "desktop",
      diagnostics: true,
      attachments: 1,
      screenshot: true,
    });
    expect(metadata.redactions).toBeGreaterThanOrEqual(7);
    expect(JSON.stringify(metadata)).not.toContain("Save does nothing");

    const fileIds = metadata.file_ids as string[];
    expect(fileIds).toHaveLength(2);
    const rows = await ctx.db.select().from(files).where(eq(files.tenant_id, ctx.tenantId));
    expect(rows.map((row) => row.filename).sort()).toEqual(["log.txt", "window-screenshot.png"]);
    expect(rows.every((row) => row.status === "ready" && row.created_by === memberId)).toBe(true);
    expect(await storedText(fileIds[0] as string)).toBe("password=[removed]\nok");
  });

  test("the admin reads the report through the intake list", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/intake/items?category=feedback`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    const body = (await res.json()) as { items: { category: string; title: string }[] };
    expect(res.status).toBe(200);
    expect(body.items.map((item) => item.title)).toContain("Bug report: Save does nothing");
  });

  test("a retry with the same request id files nothing twice", async () => {
    const body = {
      client_request_id: "4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d",
      kind: "idea",
      message: "A darker tray icon",
    };
    const first = await post(body);
    const second = await post(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(first.body.id).toBe(body.client_request_id);
    const rows = await ctx.db
      .select()
      .from(intakeItems)
      .where(eq(intakeItems.client_request_id, body.client_request_id));
    expect(rows).toHaveLength(1);
    const admin = await browserSessionHeaders(ctx, ctx.userId);
    expect((await post(body, admin)).status).toBe(409);
  });

  test("refuses invalid bodies", async () => {
    expect((await post({ kind: "praise", message: "x" })).status).toBe(400);
    expect((await post({ kind: "bug", message: "   " })).status).toBe(400);
    expect((await post({ kind: "bug", message: "x".repeat(5001) })).status).toBe(400);
    const file = { filename: "a.txt", content_base64: b64("a") };
    expect(
      (await post({ kind: "bug", message: "x", attachments: [file, file, file, file] })).status,
    ).toBe(400);
    const errors = Array.from({ length: 11 }, () => ({ code: "e", at: "2026-11-20T10:00:00Z" }));
    expect(
      (await post({ kind: "bug", message: "x", diagnostics: { recent_errors: errors } })).status,
    ).toBe(400);
  });

  test("refuses attachments of another type, with other content or over 2 MB and stores nothing", async () => {
    const before = await ctx.db.select().from(files).where(eq(files.tenant_id, ctx.tenantId));
    const html = await post({
      kind: "bug",
      message: "x",
      attachments: [{ filename: "a.html", content_base64: b64("<p>") }],
    });
    expect(html.status).toBe(422);
    const fake = await post({
      kind: "bug",
      message: "x",
      attachments: [
        { filename: "ok.txt", content_base64: b64("fine and unique") },
        { filename: "a.png", content_base64: b64("not a picture") },
      ],
    });
    expect(fake.status).toBe(422);
    const big = await post({
      kind: "bug",
      message: "x",
      attachments: [
        { filename: "a.txt", content_base64: b64(Buffer.alloc(2 * 1024 * 1024 + 1, 97)) },
      ],
    });
    expect([400, 413]).toContain(big.status);
    const shot = await post({ kind: "bug", message: "x", screenshot_png_base64: b64("nope") });
    expect(shot.status).toBe(422);
    const after = await ctx.db.select().from(files).where(eq(files.tenant_id, ctx.tenantId));
    expect(after).toHaveLength(before.length);
  });

  test("needs a signed-in person", async () => {
    const anonymous = await post(
      { kind: "bug", message: "x" },
      { "content-type": "application/json" },
    );
    expect(anonymous.status).toBe(401);
    const key = await post(
      { kind: "bug", message: "x" },
      { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
    );
    expect(key.status).toBe(403);
  });

  test("limits reports per person", async () => {
    const clock = pinAdmissionClock(new Date("2040-01-01T12:00:10.000Z"));
    try {
      resetFeedbackRateLimiter(createFeedbackRateLimiter({ max: 2, windowMs: 60_000 }));
      expect((await post({ kind: "other", message: "one" })).status).toBe(201);
      expect((await post({ kind: "other", message: "two" })).status).toBe(201);
      const third = await post({ kind: "other", message: "three" });
      expect(third.status).toBe(429);
      resetFeedbackRateLimiter(createFeedbackRateLimiter({ max: 2, windowMs: 60_000 }));
      const restarted = await post({ kind: "other", message: "after a restart" });
      expect(restarted.status).toBe(429);
      const admin = await browserSessionHeaders(ctx, ctx.userId);
      expect((await post({ kind: "other", message: "from someone else" }, admin)).status).toBe(201);
      clock.setInstant(new Date("2040-01-01T12:01:00.000Z"));
      expect((await post({ kind: "other", message: "next minute" })).status).toBe(201);
    } finally {
      clock.restore();
    }
  });
});
