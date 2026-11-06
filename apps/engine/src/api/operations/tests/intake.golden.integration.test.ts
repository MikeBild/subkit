import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { auditLog, users } from "../../../db/schema/index.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  type HttpTestServer,
} from "../../../http/tests/setup.ts";
import { createRole, grantPermissionToRole } from "../../../rbac/roles.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";

const GOLDEN_PATH = new URL("./fixtures/intake.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const CAPTURED = "2026-10-10T07:00:00.000Z";
const REQUEST = {
  capture: "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a",
  note: "2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b",
  discard: "3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c",
};

let ctx: HttpTestServer;
let deniedKey: string;
let readerKey: string;
let admin: Record<string, string>;
let confirmOnly: Record<string, string>;
const ids: Record<string, string> = {};

function uuidName(uuid: string): string {
  if (uuid === MISSING) return "<missing>";
  const known = uuidNames.get(uuid);
  if (known) return known;
  const name = `<uuid:${uuidNames.size + 1}>`;
  uuidNames.set(uuid, name);
  return name;
}

function scrub(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, (match) =>
      match === `"${CAPTURED}"` ? match : '"<now>"',
    )
    .replace(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g, "<digest>")
    .replace(/"(trace_id|audit_trace_id|request_id)":"[^"]*"/g, '"$1":"<trace>"');
}

function record(name: string, value: unknown): void {
  actual[name] = scrub(value).replace(UUID, uuidName);
  expect(actual[name]).toBe(golden[name] as string);
}

function recordRows(name: string, rows: readonly unknown[]): void {
  actual[name] = JSON.stringify(rows.map((row) => scrub(row).replace(UUID, "<id>")).sort());
  expect(actual[name]).toBe(golden[name] as string);
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function send(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: parseBody(await res.text()) };
}

function http(method: string, path: string, body?: unknown, key = ctx.apiKey) {
  return send(method, path, body, {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  });
}

function auditRows(where: ReturnType<typeof eq>) {
  return ctx.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      resource_type: auditLog.resource_type,
      resource_id: auditLog.resource_id,
      result: auditLog.result,
      reason: auditLog.reason,
      before: auditLog.before,
      after: auditLog.after,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), where));
}

async function mintKey(user_id: string, seed: number): Promise<string> {
  const key = `wf_live_${createDeterministicHexFactory(seed)(16)}`;
  await ctx.testDb.pool.query(
    "INSERT INTO subkit.api_keys (tenant_id, user_id, prefix, token_sha256, scopes) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [
      ctx.tenantId,
      user_id,
      key.slice(0, 12),
      createHash("sha256").update(key).digest("hex"),
      JSON.stringify(["*"]),
    ],
  );
  return key;
}

async function seedUser(email: string, role_id: string): Promise<string> {
  const [row] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email, role_id })
    .returning();
  if (!row) throw new Error("user insert returned no row");
  return row.id;
}

async function roleWith(name: string, permissions: readonly string[]): Promise<string> {
  const role = await createRole(ctx.db, ctx.tenantId, name);
  for (const permission of permissions)
    await grantPermissionToRole(ctx.db, ctx.tenantId, role.id, permission);
  return role.id;
}

function idOf(response: { body: unknown }): string {
  return (response.body as { id: string }).id;
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_intake_golden");
  deniedKey = await mintKey(
    await seedUser("denied-intake-operations@test.local", await emptyRoleId(ctx.db, ctx.tenantId)),
    0x1e_01,
  );
  readerKey = await mintKey(
    await seedUser(
      "reader-intake-operations@test.local",
      await roleWith("intake-reader", ["intake:read"]),
    ),
    0x1e_02,
  );
  admin = await browserSessionHeaders(ctx, ctx.userId);
  confirmOnly = await browserSessionHeaders(
    ctx,
    await seedUser(
      "confirm-intake-operations@test.local",
      await roleWith("intake-confirm-only", ["intake:read", "intake:write", "intake:confirm"]),
    ),
  );
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("intake operations keep their HTTP responses byte for byte", () => {
  test("default category", async () => {
    record("http.default.get", await http("GET", "/v1/intake/default-category"));
    record(
      "http.default.set",
      await http("PATCH", "/v1/intake/default-category", { category: "research" }),
    );
    record(
      "http.default.set.invalid",
      await http("PATCH", "/v1/intake/default-category", { category: "" }),
    );
    record("http.default.get.after", await http("GET", "/v1/intake/default-category"));
    record(
      "http.reader.default.get",
      await http("GET", "/v1/intake/default-category", undefined, readerKey),
    );
  });

  test("items", async () => {
    const capture = await http("POST", "/v1/intake/items", {
      client_request_id: REQUEST.capture,
      title: "Golden capture",
      source_url: "https://example.test/golden",
      source_author: "Golden Author",
      captured_at: CAPTURED,
      body: "Captured body",
      note: "first note",
    });
    ids.capture = idOf(capture);
    record("http.items.create.capture", capture);
    record(
      "http.items.create.replay",
      await http("POST", "/v1/intake/items", {
        client_request_id: REQUEST.capture,
        title: "Golden capture",
        source_url: "https://example.test/golden",
        source_author: "Golden Author",
        captured_at: CAPTURED,
        body: "Captured body",
        note: "first note",
      }),
    );
    record(
      "http.items.create.conflict",
      await http("POST", "/v1/intake/items", {
        client_request_id: REQUEST.capture,
        title: "Different",
        captured_at: CAPTURED,
        body: "Different body",
      }),
    );
    const note = await http("POST", "/v1/intake/items", {
      client_request_id: REQUEST.note,
      category: "jira",
      title: "Golden note",
      captured_at: CAPTURED,
      body: "Note body",
    });
    ids.note = idOf(note);
    record("http.items.create.note", note);
    record(
      "http.items.create.invalid",
      await http("POST", "/v1/intake/items", {
        client_request_id: "nope",
        title: "",
        captured_at: CAPTURED,
        body: "x",
        original_snapshot: { source_url: "https://example.test/x", origin: "capture" },
      }),
    );
    const discard = await http("POST", "/v1/intake/items", {
      client_request_id: REQUEST.discard,
      title: "Golden discard",
      captured_at: CAPTURED,
      body: "Discard body",
    });
    ids.discard = idOf(discard);
    record("http.items.create.discard", discard);
    record("http.items.list", await http("GET", "/v1/intake/items"));
    record("http.items.list.category", await http("GET", "/v1/intake/items?category=jira"));
    record("http.items.list.origin", await http("GET", "/v1/intake/items?origin=note"));
    record("http.items.list.state", await http("GET", "/v1/intake/items?state=reviewing"));
    record("http.items.list.invalid", await http("GET", "/v1/intake/items?state=nope"));
    record("http.items.mentions", await http("GET", "/v1/intake/items/mentions"));
    record("http.items.mentions.id", await http("GET", `/v1/intake/items/mentions?id=${ids.note}`));
    record("http.items.mentions.q", await http("GET", "/v1/intake/items/mentions?q=CAPTURE"));
    record("http.items.mentions.invalid", await http("GET", "/v1/intake/items/mentions?id=x"));
    record("http.items.get", await http("GET", `/v1/intake/items/${ids.capture}`));
    record("http.items.get.missing", await http("GET", `/v1/intake/items/${MISSING}`));
    record("http.items.get.invalid", await http("GET", "/v1/intake/items/nope"));
  });

  test("item organize and delete", async () => {
    record(
      "http.items.patch",
      await http("PATCH", `/v1/intake/items/${ids.capture}`, {
        expected_version: 1,
        title: "Golden capture renamed",
        state: "reviewing",
      }),
    );
    record(
      "http.items.patch.stale",
      await http("PATCH", `/v1/intake/items/${ids.capture}`, { expected_version: 1, note: "x" }),
    );
    record(
      "http.items.patch.missing",
      await http("PATCH", `/v1/intake/items/${MISSING}`, { expected_version: 1, note: "x" }),
    );
    record(
      "http.items.patch.empty",
      await http("PATCH", `/v1/intake/items/${ids.capture}`, { expected_version: 2 }),
    );
    record(
      "http.items.delete.api-key",
      await http("DELETE", `/v1/intake/items/${ids.discard}`, { expected_version: 1 }),
    );
    record(
      "http.items.delete.not-discarded",
      await send("DELETE", `/v1/intake/items/${ids.discard}`, { expected_version: 1 }, admin),
    );
    record(
      "http.items.patch.discard",
      await http("PATCH", `/v1/intake/items/${ids.discard}`, {
        expected_version: 1,
        state: "discarded",
      }),
    );
    record(
      "http.items.delete.stale",
      await send("DELETE", `/v1/intake/items/${ids.discard}`, { expected_version: 1 }, admin),
    );
    record(
      "http.items.delete",
      await send("DELETE", `/v1/intake/items/${ids.discard}`, { expected_version: 2 }, admin),
    );
    record(
      "http.items.delete.missing",
      await send("DELETE", `/v1/intake/items/${MISSING}`, { expected_version: 1 }, admin),
    );
    record(
      "http.items.delete.invalid",
      await send("DELETE", `/v1/intake/items/${ids.discard}`, {}, admin),
    );
  });

  test("proposals", async () => {
    const created = await http("POST", "/v1/intake/proposals", {
      item_ids: [ids.capture],
      title: "Golden proposal",
      body: "Golden proposal body",
      target: { name: "Golden knowledge" },
    });
    ids.proposal = idOf(created);
    record("http.proposals.create", created);
    record(
      "http.proposals.create.missing-item",
      await http("POST", "/v1/intake/proposals", {
        item_ids: [MISSING],
        title: "Missing",
        body: "Missing body",
        target: { name: "Missing knowledge" },
      }),
    );
    record(
      "http.proposals.create.invalid",
      await http("POST", "/v1/intake/proposals", { item_ids: [], title: "x" }),
    );
    record("http.proposals.list", await http("GET", "/v1/intake/proposals"));
    record("http.proposals.list.status", await http("GET", "/v1/intake/proposals?status=stale"));
    record("http.proposals.get", await http("GET", `/v1/intake/proposals/${ids.proposal}`));
    record("http.proposals.get.missing", await http("GET", `/v1/intake/proposals/${MISSING}`));
    const revised = await http("PATCH", `/v1/intake/proposals/${ids.proposal}`, {
      item_ids: [ids.note],
      title: "Golden proposal revised",
      body: "Golden proposal body revised",
      target: { name: "Golden knowledge" },
      expected_revision: 1,
    });
    record("http.proposals.revise", revised);
    record(
      "http.proposals.revise.stale",
      await http("PATCH", `/v1/intake/proposals/${ids.proposal}`, {
        item_ids: [ids.capture],
        title: "Stale",
        body: "Stale body",
        target: { name: "Golden knowledge" },
        expected_revision: 1,
      }),
    );
    record(
      "http.proposals.revise.missing",
      await http("PATCH", `/v1/intake/proposals/${MISSING}`, {
        item_ids: [ids.capture],
        title: "Missing",
        body: "Missing body",
        target: { name: "Golden knowledge" },
        expected_revision: 1,
      }),
    );
    const digest = (revised.body as { revision: { digest: string } }).revision.digest;
    const confirmPath = `/v1/intake/proposals/${ids.proposal}/confirm`;
    record(
      "http.proposals.confirm.api-key",
      await http("POST", confirmPath, { expected_revision: 2, digest }),
    );
    record(
      "http.proposals.confirm.target-denied",
      await send("POST", confirmPath, { expected_revision: 2, digest }, confirmOnly),
    );
    record(
      "http.proposals.confirm.stale",
      await send("POST", confirmPath, { expected_revision: 1, digest }, admin),
    );
    record(
      "http.proposals.confirm.missing",
      await send(
        "POST",
        `/v1/intake/proposals/${MISSING}/confirm`,
        { expected_revision: 1, digest },
        admin,
      ),
    );
    record(
      "http.proposals.confirm.invalid",
      await send("POST", confirmPath, { expected_revision: 2, digest: "nope" }, admin),
    );
    record(
      "http.proposals.confirm",
      await send("POST", confirmPath, { expected_revision: 2, digest }, admin),
    );
    record(
      "http.proposals.confirm.again",
      await send("POST", confirmPath, { expected_revision: 2, digest }, admin),
    );
    const second = await http("POST", "/v1/intake/proposals", {
      item_ids: [ids.capture],
      title: "Golden rejected proposal",
      body: "Rejected body",
      target: { name: "Golden rejected knowledge" },
    });
    ids.rejected = idOf(second);
    record(
      "http.proposals.reject.stale",
      await http("POST", `/v1/intake/proposals/${ids.rejected}/reject`, { expected_revision: 2 }),
    );
    record(
      "http.proposals.reject",
      await http("POST", `/v1/intake/proposals/${ids.rejected}/reject`, { expected_revision: 1 }),
    );
    record(
      "http.proposals.reject.missing",
      await http("POST", `/v1/intake/proposals/${MISSING}/reject`, { expected_revision: 1 }),
    );
  });

  test("permissions are checked", async () => {
    const item = ids.capture;
    const proposal = ids.proposal;
    const probes: [string, string, string, unknown?][] = [
      ["default.get", "GET", "/v1/intake/default-category"],
      ["default.set", "PATCH", "/v1/intake/default-category", { category: "inbox" }],
      ["items.list", "GET", "/v1/intake/items"],
      ["items.create", "POST", "/v1/intake/items", {}],
      ["items.mentions", "GET", "/v1/intake/items/mentions"],
      ["items.get", "GET", `/v1/intake/items/${item}`],
      ["items.patch", "PATCH", `/v1/intake/items/${item}`, {}],
      ["items.delete", "DELETE", `/v1/intake/items/${item}`, {}],
      ["proposals.list", "GET", "/v1/intake/proposals"],
      ["proposals.create", "POST", "/v1/intake/proposals", {}],
      ["proposals.get", "GET", `/v1/intake/proposals/${proposal}`],
      ["proposals.revise", "PATCH", `/v1/intake/proposals/${proposal}`, {}],
      ["proposals.confirm", "POST", `/v1/intake/proposals/${proposal}/confirm`, {}],
      ["proposals.reject", "POST", `/v1/intake/proposals/${proposal}/reject`, {}],
      ["head.items", "HEAD", "/v1/intake/items"],
      ["head.proposal", "HEAD", `/v1/intake/proposals/${proposal}`],
      ["other-method.items", "PUT", "/v1/intake/items", {}],
      ["other-method.proposal", "PUT", `/v1/intake/proposals/${proposal}`, {}],
      ["other-method.reject", "GET", `/v1/intake/proposals/${proposal}/reject`],
      ["other-method.confirm", "GET", `/v1/intake/proposals/${proposal}/confirm`],
    ];
    for (const [who, key] of [
      ["denied", deniedKey],
      ["reader", readerKey],
    ] as const) {
      for (const [name, method, path, body] of probes)
        record(`http.${who}.${name}`, await http(method, path, body, key));
    }
    recordRows("http.denied.audit", await auditRows(eq(auditLog.result, "denied")));
  });

  test("audit trail of the written intake resources", async () => {
    recordRows(
      "http.audit",
      await auditRows(
        inArray(auditLog.resource_id, [
          ids.capture,
          ids.note,
          ids.discard,
          ids.proposal,
          ids.rejected,
        ] as string[]),
      ),
    );
    recordRows(
      "http.audit.default",
      await auditRows(eq(auditLog.resource_type, "intake_category_default")),
    );
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
