import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, httpRateLimitBuckets, intakeItems, tenants } from "../../../db/schema/index.ts";
import {
  type ANONYMOUS_FEEDBACK_LIMITS,
  ANONYMOUS_FEEDBACK_MAX_BODY_BYTES,
  createAnonymousFeedbackRateLimiter,
} from "../../../feedback/index.ts";
import { resetAnonymousFeedbackRateLimiter } from "../../../http/routes/feedback.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  type HttpTestServer,
} from "../../../http/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { resetFeedbackRateLimiter } from "../feedback.ts";

const uuid = createDeterministicUuidFactory(0xfeed);
const JSON_HEADERS = { "content-type": "application/json" };
const DEVICE_A = "3f2c1b9a-7d4e-4c1a-9b8e-2a6f0c5d1e77";
const DEVICE_B = "9a1e5c7d-2b4f-4e6a-8c0d-1f3b5d7e9a2c";

let ctx: HttpTestServer;

async function send(body: unknown, headers: Record<string, string> = JSON_HEADERS) {
  const res = await fetch(`${ctx.baseUrl}/v1/feedback/anonymous`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return {
    status: res.status,
    retryAfter: res.headers.get("retry-after"),
    body: (await res.json()) as Record<string, unknown>,
  };
}

function limits(over: Partial<typeof ANONYMOUS_FEEDBACK_LIMITS>) {
  resetAnonymousFeedbackRateLimiter(
    createAnonymousFeedbackRateLimiter({
      ip: { max: 10, windowMs: 600_000 },
      device: { max: 10, windowMs: 600_000 },
      instance: { max: 10, windowMs: 600_000 },
      ...over,
    }),
  );
}

async function itemOf(id: unknown) {
  const [row] = await ctx.db
    .select()
    .from(intakeItems)
    .where(eq(intakeItems.id, String(id)));
  if (!row) throw new Error("intake item missing");
  return row;
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_feedback_anonymous");
});

beforeEach(async () => {
  resetAnonymousFeedbackRateLimiter();
  await ctx.db.delete(httpRateLimitBuckets);
});

afterAll(async () => {
  resetAnonymousFeedbackRateLimiter();
  resetFeedbackRateLimiter();
  await ctx.cleanup();
});

describe("POST /v1/feedback/anonymous", () => {
  test("files a cleaned report as anonymous in the operator workspace without any session", async () => {
    const res = await send({
      kind: "bug",
      message:
        "Sign-in loops\nAuthorization: Bearer abcdefgh12345678\nsee https://subkit.example.test/x?token=zzz and /Users/alex/notes.txt",
      diagnostics: { client_kind: "desktop", connection: "offline as alex@example.test" },
      device_id: DEVICE_A,
    });
    expect(res.status).toBe(201);
    expect(res.body.replayed).toBe(false);

    const item = await itemOf(res.body.intake_item_id);
    expect(item.tenant_id).toBe(ctx.tenantId);
    expect(item.category).toBe("feedback");
    expect(item.collected_by_type).toBe("anonymous");
    expect(item.collected_by_id).toBeNull();
    for (const leaked of ["abcdefgh12345678", "token=zzz", "/Users/alex", "alex@example.test"])
      expect(item.body).not.toContain(leaked);
    expect(item.body).toContain("Authorization: [removed]");
    expect(item.body).not.toContain(DEVICE_A);

    const [audit] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "feedback.submitted"), eq(auditLog.resource_id, item.id)));
    expect(audit?.tenant_id).toBe(ctx.tenantId);
    expect(audit?.actor_type).toBe("unknown");
    expect(audit?.actor_id).toBeNull();
    expect(audit?.metadata).toMatchObject({ provenance: "anonymous", client_kind: "desktop" });
    expect(JSON.stringify(audit?.metadata)).not.toContain("abcdefgh12345678");
  });

  test("is listed for admins like every other report", async () => {
    const filed = await send({ kind: "idea", message: "Offer dark mode on the sign-in page" });
    expect(filed.status).toBe(201);
    const admin = await browserSessionHeaders(ctx, ctx.userId);
    const res = await fetch(`${ctx.baseUrl}/v1/intake/items?category=feedback`, {
      headers: admin,
    });
    expect(res.status).toBe(200);
    const listed = (await res.json()) as {
      items: Array<{ id: string; collected_by: { kind: string; id: string | null } }>;
    };
    const item = listed.items.find((entry) => entry.id === filed.body.intake_item_id);
    expect(item?.collected_by).toEqual({ kind: "anonymous", id: null });
  });

  test("counts each address on its own", async () => {
    limits({ ip: { max: 1, windowMs: 600_000 } });
    expect((await send({ kind: "other", message: "first" })).status).toBe(201);
    const second = await send({ kind: "other", message: "second", device_id: DEVICE_B });
    expect(second.status).toBe(429);
    expect(second.body.code).toBe("rate_limit_exceeded");
    expect(Number(second.retryAfter)).toBeGreaterThan(0);
  });

  test("counts each desktop device on its own", async () => {
    limits({ device: { max: 1, windowMs: 600_000 } });
    expect((await send({ kind: "bug", message: "one", device_id: DEVICE_A })).status).toBe(201);
    expect((await send({ kind: "bug", message: "two", device_id: DEVICE_A })).status).toBe(429);
    expect((await send({ kind: "bug", message: "three", device_id: DEVICE_B })).status).toBe(201);
  });

  test("caps the whole server", async () => {
    limits({ instance: { max: 1, windowMs: 600_000 } });
    expect((await send({ kind: "bug", message: "one", device_id: DEVICE_A })).status).toBe(201);
    expect((await send({ kind: "bug", message: "two", device_id: DEVICE_B })).status).toBe(429);
  });

  test("refuses a request larger than the anonymous cap before reading it", async () => {
    const chunk = Buffer.alloc(2 * 1024 * 1024 - 16, 97).toString("base64");
    const body = JSON.stringify({
      kind: "bug",
      message: "too large",
      attachments: [1, 2, 3].map((n) => ({ filename: `log-${n}.txt`, content_base64: chunk })),
    });
    expect(Buffer.byteLength(body)).toBeGreaterThan(ANONYMOUS_FEEDBACK_MAX_BODY_BYTES);
    const res = await send(body);
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("payload_too_large");
    const rows = await ctx.db
      .select({ id: intakeItems.id })
      .from(intakeItems)
      .where(eq(intakeItems.title, "Bug report: too large"));
    expect(rows).toHaveLength(0);
  });

  test("keeps the existing limit for each file", async () => {
    const res = await send({
      kind: "bug",
      message: "one big file",
      attachments: [
        {
          filename: "log.txt",
          content_base64: Buffer.alloc(2 * 1024 * 1024 + 1, 97).toString("base64"),
        },
      ],
    });
    expect(res.status).toBe(413);
    expect(res.body.details).toMatchObject({ reason: "attachment_too_large" });
  });

  test("refuses a browser request from another site", async () => {
    const res = await send(
      { kind: "bug", message: "cross" },
      { ...JSON_HEADERS, "sec-fetch-site": "cross-site" },
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("csrf_rejected");
  });

  test("never replays a signed-in person's report", async () => {
    const id = uuid();
    const member = await browserSessionHeaders(ctx, ctx.userId);
    const signedIn = await fetch(`${ctx.baseUrl}/v1/feedback`, {
      method: "POST",
      headers: member,
      body: JSON.stringify({ kind: "bug", message: "mine", client_request_id: id }),
    });
    expect(signedIn.status).toBe(201);
    const res = await send({ kind: "bug", message: "mine", client_request_id: id });
    expect(res.status).toBe(409);
  });

  test("replays an anonymous report sent again with the same id", async () => {
    const id = uuid();
    const first = await send({ kind: "bug", message: "retry me", client_request_id: id });
    const second = await send({ kind: "bug", message: "retry me", client_request_id: id });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual({ ...first.body, replayed: true });
  });

  test("answers 503 when the server has no operator workspace", async () => {
    await ctx.db.update(tenants).set({ is_operator: false }).where(eq(tenants.id, ctx.tenantId));
    try {
      const res = await send({ kind: "bug", message: "nowhere to go" });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("feedback_unavailable");
    } finally {
      await ctx.db.update(tenants).set({ is_operator: true }).where(eq(tenants.id, ctx.tenantId));
    }
  });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function postForm(
  fields: Record<string, string | File>,
  headers: Record<string, string> = { "accept-language": "de" },
) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const res = await fetch(`${ctx.baseUrl}/v1/feedback/anonymous/form`, {
    method: "POST",
    headers,
    body: form,
  });
  return { status: res.status, html: await res.text() };
}

describe("the report form for the sign-in page", () => {
  test("is a page in the reader's language", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/feedback/anonymous/form`, {
      headers: { "accept-language": "en" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Report a problem");
    expect(html).toContain('data-testid="feedback-form"');
  });

  test("files text, address and screenshot as an anonymous report", async () => {
    const res = await postForm({
      message: "Anmeldung hängt\nAuthorization: Bearer abcdefgh12345678",
      email: "alex@example.test",
      screenshot: new File([PNG], "bild.png", { type: "image/png" }),
    });
    expect(res.status).toBe(201);
    expect(res.html).toContain("Danke für deine Meldung");
    const [item] = await ctx.db
      .select()
      .from(intakeItems)
      .where(eq(intakeItems.title, "Bug report: Anmeldung hängt"));
    expect(item?.collected_by_type).toBe("anonymous");
    expect(item?.body).toContain("- Email: alex@example.test");
    expect(item?.body).toContain("- bild.png (image/png, 12 B)");
    expect(item?.body).toContain("- Client: browser");
    expect(item?.body).not.toContain("abcdefgh12345678");
  });

  test("keeps the text and names the problem when a field is wrong", async () => {
    const res = await postForm({ message: "Etwas klemmt", email: "kein-postfach" });
    expect(res.status).toBe(400);
    expect(res.html).toContain("Etwas klemmt</textarea>");
    expect(res.html).toContain("Gib eine gültige E-Mail-Adresse ein oder lass das Feld leer.");
  });

  test("explains the limit and keeps the text", async () => {
    limits({ ip: { max: 1, windowMs: 600_000 } });
    expect((await postForm({ message: "eins" })).status).toBe(201);
    const res = await postForm({ message: "zwei" });
    expect(res.status).toBe(429);
    expect(res.html).toContain("Gerade gehen zu viele Meldungen ein.");
    expect(res.html).toContain("zwei</textarea>");
  });

  test("refuses a form sent from another site", async () => {
    const res = await postForm(
      { message: "fremd" },
      { "accept-language": "en", "sec-fetch-site": "cross-site" },
    );
    expect(res.status).toBe(403);
    expect(res.html).toContain("The server didn’t accept the report.");
  });
});
