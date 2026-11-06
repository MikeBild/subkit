import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, like, or } from "drizzle-orm";
import { appendSnapshot } from "../../../conversations/draft.ts";
import { createElicitation } from "../../../conversations/elicitations.ts";
import type { DraftDocument } from "../../../conversations/types.ts";
import {
  apiKeys,
  auditLog,
  conversations,
  conversationToolCalls,
  users,
} from "../../../db/schema/index.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  type HttpTestServer,
} from "../../../http/tests/setup.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";

const GOLDEN_PATH = new URL("./fixtures/conversation-routes.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

let ctx: HttpTestServer;
let deniedKey: string;
let browser: Record<string, string>;
let draftId: string;
let confirmId: string;
let plainId: string;

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
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"(trace_id|audit_trace_id|request_id)":"[^"]*"/g, '"$1":"<trace>"')
    .replace(/"(duration_ms|elapsed_ms|latency_ms)":\d+/g, '"$1":"<ms>"');
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

async function http(
  method: string,
  path: string,
  body?: unknown,
  key: string | null = ctx.apiKey,
  extra: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      "content-type": "application/json",
      ...extra,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: parseBody(text) };
}

function auditRows(where: ReturnType<typeof eq | typeof like | typeof or>) {
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
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id,
    prefix: key.slice(0, 12),
    token_sha256: createHash("sha256").update(key).digest("hex"),
    scopes: ["*"],
  });
  return key;
}

async function seedConversation(title: string): Promise<string> {
  const [row] = await ctx.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenantId, status: "active", title, owner_id: ctx.userId })
    .returning();
  if (!row) throw new Error("conversation insert returned no row");
  return row.id;
}

function workflowDraft(): DraftDocument {
  return {
    workflow: {
      name: "golden-flow",
      slug: "golden-flow",
      steps: [{ id: "fetch", kind: "transform", language: "javascript", expression: "return 1;" }],
    },
  } as unknown as DraftDocument;
}

async function seedPendingConfirm(
  title: string,
  callInput: Record<string, unknown>,
  elicitationInput: Record<string, unknown>,
): Promise<string> {
  const id = await seedConversation(title);
  const [call] = await ctx.db
    .insert(conversationToolCalls)
    .values({
      tenant_id: ctx.tenantId,
      conversation_id: id,
      tool: "ask_user_confirm",
      input: callInput,
      approval_required: false,
    })
    .returning({ id: conversationToolCalls.id });
  if (!call) throw new Error("tool call insert returned no row");
  await createElicitation(
    {
      tenant_id: ctx.tenantId,
      conversation_id: id,
      tool_call_id: call.id,
      tool_name: "ask_user_confirm",
      summary: title,
      input: elicitationInput,
      actor_id: null,
    },
    ctx.db,
  );
  return id;
}

async function pendingPromptOf(id: string): Promise<unknown> {
  const { body } = await http("GET", `/v1/conversations/${id}`);
  return (body as { resume_summary: { pending_approval: { prompt: unknown } } }).resume_summary
    .pending_approval.prompt;
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_conversation_routes_golden");
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-conversation-routes@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  deniedKey = await mintKey(denied.id, 0x6d_01);
  browser = await browserSessionHeaders(ctx, ctx.userId);
  draftId = await seedConversation("routes-draft");
  await appendSnapshot(ctx.tenantId, draftId, workflowDraft(), ctx.db);
  confirmId = await seedConversation("routes-confirm");
  plainId = await seedConversation("routes-plain");
  const [call] = await ctx.db
    .insert(conversationToolCalls)
    .values({
      tenant_id: ctx.tenantId,
      conversation_id: confirmId,
      tool: "ask_user_confirm",
      input: {
        question: "Apply these changes?",
        kind: "partial_diff_approval",
        diffs: [{ label: "replace /steps/0", preview: "return 2;" }, { label: "remove /steps/1" }],
      },
      approval_required: false,
    })
    .returning({ id: conversationToolCalls.id });
  if (!call) throw new Error("tool call insert returned no row");
  await createElicitation(
    {
      tenant_id: ctx.tenantId,
      conversation_id: confirmId,
      tool_call_id: call.id,
      tool_name: "ask_user_confirm",
      summary: "Apply these changes?",
      input: {
        question: "Apply these changes?",
        kind: "partial_diff_approval",
        diffs: [{ label: "replace /steps/0", preview: "return 2;" }, { label: "remove /steps/1" }],
      },
      actor_id: null,
    },
    ctx.db,
  );
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("conversation routes keep their HTTP responses byte for byte", () => {
  test("list", async () => {
    record("http.list", await http("GET", "/v1/conversations?owner=me&sort=title&order=asc"));
    record("http.list.paged", await http("GET", "/v1/conversations?limit=1&offset=1&sort=title"));
    record("http.list.query", await http("GET", "/v1/conversations?q=plain"));
    record(
      "http.list.referenced-skill",
      await http("GET", `/v1/conversations?referenced_skill_id=${MISSING}`),
    );
    record(
      "http.list.referenced-knowledge",
      await http("GET", `/v1/conversations?referenced_knowledge_source_id=${MISSING}`),
    );
    record("http.list.invalid", await http("GET", "/v1/conversations?limit=0"));
  });

  test("detail and patch", async () => {
    record("http.detail.plain", await http("GET", `/v1/conversations/${plainId}`));
    record("http.detail.confirm", await http("GET", `/v1/conversations/${confirmId}`));
    record("http.detail.missing", await http("GET", `/v1/conversations/${MISSING}`));
    record("http.detail.invalid", await http("GET", "/v1/conversations/nope"));
    record(
      "http.patch",
      await http("PATCH", `/v1/conversations/${plainId}`, { title: "routes-plain-renamed" }),
    );
    record(
      "http.patch.missing",
      await http("PATCH", `/v1/conversations/${MISSING}`, { title: "x" }),
    );
    record(
      "http.patch.invalid-body",
      await http("PATCH", `/v1/conversations/${plainId}`, { title: 7 }),
    );
  });

  test("a pending confirm in the detail carries kind and diffs from the stored call input", async () => {
    const { body } = await http("GET", `/v1/conversations/${confirmId}`);
    const summary = (body as { resume_summary: { pending_approval: { prompt: unknown } } })
      .resume_summary;
    expect(summary.pending_approval.prompt).toEqual({
      question: "Apply these changes?",
      kind: "partial_diff_approval",
      diffs: [{ label: "replace /steps/0", preview: "return 2;" }, { label: "remove /steps/1" }],
    });
  });

  test("diffs derived from the commit intent come from the stored question input", async () => {
    const patches = [{ op: "replace", path: "/steps/0/expression", value: "return 2;" }];
    const id = await seedPendingConfirm(
      "routes-derived-diffs",
      {
        question: "Apply the patch?",
        kind: "partial_diff_approval",
        commit_intent: { kind: "apply_workflow_patch", payload: { patches } },
      },
      {
        question: "Apply the patch?",
        kind: "partial_diff_approval",
        commit_intent: { kind: "apply_workflow_patch", payload: { patches } },
        diffs: [{ label: "replace /steps/0/expression", preview: "return 2;" }],
      },
    );
    expect(await pendingPromptOf(id)).toEqual({
      question: "Apply the patch?",
      intent_kind: "apply_workflow_patch",
      kind: "partial_diff_approval",
      diffs: [{ label: "replace /steps/0/expression", preview: "return 2;" }],
    });
  });

  test("a stored question input without kind and diffs falls back to the tool call input", async () => {
    const id = await seedPendingConfirm(
      "routes-call-fallback",
      { question: "Keep going?", kind: "external_write", diffs: [{ label: "send mail" }] },
      { question: "Keep going?" },
    );
    expect(await pendingPromptOf(id)).toEqual({
      question: "Keep going?",
      kind: "external_write",
      diffs: [{ label: "send mail" }],
    });
  });

  test("direct tools", async () => {
    record(
      "http.snapshots",
      await http("GET", `/v1/conversations/${draftId}/draft/snapshots?limit=5`),
    );
    record(
      "http.snapshots.invalid",
      await http("GET", `/v1/conversations/${draftId}/draft/snapshots?limit=0`),
    );
    record(
      "http.preview.mode-with-step",
      await http("POST", `/v1/conversations/${draftId}/preview`, {
        step_id: "fetch",
        mode: "schema_only",
      }),
    );
    record("http.preview.missing", await http("POST", `/v1/conversations/${MISSING}/preview`, {}));
    record(
      "http.preview.blocked",
      await http("POST", `/v1/conversations/${confirmId}/preview`, {}),
    );
    record("http.probe.no-connector", await http("POST", `/v1/conversations/${draftId}/probe`, {}));
    record(
      "http.patch-draft.invalid-body",
      await http("POST", `/v1/conversations/${draftId}/draft/patch`, { patches: [] }),
    );
    record(
      "http.patch-draft.invalid-args",
      await http("POST", `/v1/conversations/${draftId}/draft/patch`, {
        patches: [{ op: "remove", path: "/nope/0" }],
      }),
    );
    record(
      "http.restore.missing-snapshot",
      await http("POST", `/v1/conversations/${draftId}/draft/snapshots/restore`, {
        snapshot_id: MISSING,
      }),
    );
  });

  test("tool policies", async () => {
    record("http.policies", await http("GET", `/v1/conversations/${plainId}/tool-policies`));
    record(
      "http.policies.put",
      await http("PUT", `/v1/conversations/${plainId}/tool-policies`, {
        policies: { run_workflow: "confirm_before_execution" },
      }),
    );
    record(
      "http.policies.put.not-allowed",
      await http("PUT", `/v1/conversations/${plainId}/tool-policies`, {
        policies: { call_connector: "no_confirm" },
      }),
    );
    record(
      "http.policies.put.no-confirm-key",
      await http("PUT", `/v1/conversations/${plainId}/tool-policies`, {
        policies: { save_workflow_draft: "no_confirm" },
      }),
    );
    record(
      "http.policies.put.no-confirm-browser",
      await http(
        "PUT",
        `/v1/conversations/${plainId}/tool-policies`,
        { policies: { save_workflow_draft: "no_confirm" } },
        null,
        browser,
      ),
    );
    record(
      "http.policies.put.invalid",
      await http("PUT", `/v1/conversations/${plainId}/tool-policies`, {
        policies: { call_connector: "asdf" },
      }),
    );
    record(
      "http.policies.missing",
      await http("GET", `/v1/conversations/${MISSING}/tool-policies`),
    );
    record(
      "http.policies.put.missing",
      await http("PUT", `/v1/conversations/${MISSING}/tool-policies`, { policies: {} }),
    );
  });

  test("suggest-next feedback", async () => {
    const path = `/v1/conversations/${plainId}/suggest-next/feedback`;
    record("http.feedback", await http("POST", path, { accepted: true, source: "tab" }));
    record(
      "http.feedback.missing",
      await http("POST", `/v1/conversations/${MISSING}/suggest-next/feedback`, {
        accepted: false,
        source: "dismissed",
      }),
    );
    record("http.feedback.invalid", await http("POST", path, { accepted: "yes" }));
  });

  test("attachments", async () => {
    const path = `/v1/conversations/${plainId}/attachments`;
    const content_base64 = Buffer.from("openapi: 3.1.0\n", "utf8").toString("base64");
    record(
      "http.attachments.upload",
      await http("POST", path, { filename: "golden-spec.yaml", content_base64 }),
    );
    record(
      "http.attachments.upload.again",
      await http("POST", path, { filename: "golden-spec.yaml", content_base64 }),
    );
    record(
      "http.attachments.upload.empty",
      await http("POST", path, { filename: "empty.txt", content_base64: "====" }),
    );
    record(
      "http.attachments.upload.file-missing",
      await http("POST", path, { $file: `fid_${MISSING}` }),
    );
    record(
      "http.attachments.upload.conversation-missing",
      await http("POST", `/v1/conversations/${MISSING}/attachments`, {
        filename: "x.txt",
        content_base64,
      }),
    );
    record("http.attachments.upload.invalid", await http("POST", path, { filename: "" }));
    record("http.attachments.list", await http("GET", path));
    record(
      "http.attachments.list.missing",
      await http("GET", `/v1/conversations/${MISSING}/attachments`),
    );
    record("http.attachments.delete", await http("DELETE", `${path}/golden-spec`));
    record("http.attachments.delete.again", await http("DELETE", `${path}/golden-spec`));
    record("http.attachments.list.after", await http("GET", path));
  });

  test("workflow reviews", async () => {
    const path = `/v1/conversations/${plainId}/workflow-reviews`;
    const prepare = { elicitation_id: MISSING, activate: false, grant: null, schedule: null };
    const withoutCsrf = { ...browser };
    delete withoutCsrf["x-subkit-csrf"];
    const asBrowser = (method: string, target: string, body?: unknown, headers = browser) =>
      http(method, target, body, null, headers);
    record("http.reviews.get.api-key", await http("GET", `${path}/${MISSING}`));
    record("http.reviews.prepare.api-key", await http("POST", path, prepare));
    record("http.reviews.get.missing", await asBrowser("GET", `${path}/${MISSING}`));
    record("http.reviews.get.invalid", await asBrowser("GET", `${path}/nope`));
    record("http.reviews.prepare.missing", await asBrowser("POST", path, prepare));
    record("http.reviews.prepare.no-csrf", await asBrowser("POST", path, prepare, withoutCsrf));
    record(
      "http.reviews.prepare.cross-site",
      await asBrowser("POST", path, prepare, { ...browser, "sec-fetch-site": "cross-site" }),
    );
    record("http.reviews.prepare.invalid", await asBrowser("POST", path, { activate: "x" }));
    record(
      "http.reviews.finalize.missing",
      await asBrowser("POST", `${path}/${MISSING}/finalize`, {}),
    );
    record(
      "http.reviews.finalize.unknown",
      await asBrowser("POST", `${path}/${MISSING}/finalize`, {
        expected_snapshot_digest: "a".repeat(64),
      }),
    );
    record(
      "http.reviews.finalize.api-key-valid",
      await http("POST", `${path}/${MISSING}/finalize`, {
        expected_snapshot_digest: "a".repeat(64),
      }),
    );
    record(
      "http.reviews.finalize.no-csrf",
      await asBrowser("POST", `${path}/${MISSING}/finalize`, {}, withoutCsrf),
    );
    record("http.reviews.finalize.api-key", await http("POST", `${path}/${MISSING}/finalize`, {}));
  });

  test("permission is checked before the input is validated", async () => {
    const id = plainId;
    const denied = (method: string, path: string, body?: unknown) =>
      http(method, path, body, deniedKey);
    record("http.denied.list", await denied("GET", "/v1/conversations?limit=0"));
    record("http.denied.head.list", await denied("HEAD", "/v1/conversations"));
    record("http.denied.detail", await denied("GET", `/v1/conversations/${id}`));
    record("http.denied.head.detail", await denied("HEAD", `/v1/conversations/${id}`));
    record("http.denied.patch", await denied("PATCH", `/v1/conversations/${id}`, { title: 7 }));
    record(
      "http.denied.snapshots",
      await denied("GET", `/v1/conversations/${id}/draft/snapshots?limit=0`),
    );
    record("http.denied.preview", await denied("POST", `/v1/conversations/${id}/preview`, {}));
    record("http.denied.probe", await denied("POST", `/v1/conversations/${id}/probe`, {}));
    record(
      "http.denied.patch-draft",
      await denied("POST", `/v1/conversations/${id}/draft/patch`, { patches: [] }),
    );
    record(
      "http.denied.restore",
      await denied("POST", `/v1/conversations/${id}/draft/snapshots/restore`, {}),
    );
    record("http.denied.policies", await denied("GET", `/v1/conversations/${id}/tool-policies`));
    record(
      "http.denied.policies.put",
      await denied("PUT", `/v1/conversations/${id}/tool-policies`, { policies: {} }),
    );
    record(
      "http.denied.feedback",
      await denied("POST", `/v1/conversations/${id}/suggest-next/feedback`, {}),
    );
    record(
      "http.denied.attachments.list",
      await denied("GET", `/v1/conversations/${id}/attachments`),
    );
    record(
      "http.denied.attachments.upload",
      await denied("POST", `/v1/conversations/${id}/attachments`, {}),
    );
    record(
      "http.denied.attachments.delete",
      await denied("DELETE", `/v1/conversations/${id}/attachments/golden-spec`),
    );
    record(
      "http.denied.reviews.get",
      await denied("GET", `/v1/conversations/${id}/workflow-reviews/${MISSING}`),
    );
    record(
      "http.denied.reviews.prepare",
      await denied("POST", `/v1/conversations/${id}/workflow-reviews`, {}),
    );
    record(
      "http.denied.reviews.finalize",
      await denied("POST", `/v1/conversations/${id}/workflow-reviews/${MISSING}/finalize`, {}),
    );
    record(
      "http.denied.other-method.preview",
      await denied("GET", `/v1/conversations/${id}/preview`),
    );
    record(
      "http.denied.other-method.attachments",
      await denied("PATCH", `/v1/conversations/${id}/attachments`, {}),
    );
    recordRows("http.denied.audit", await auditRows(eq(auditLog.result, "denied")));
  });

  test("unauthenticated requests are refused", async () => {
    record(
      "http.unauthenticated.detail",
      await http("GET", `/v1/conversations/${plainId}`, undefined, null),
    );
    record(
      "http.unauthenticated.attachments",
      await http("GET", `/v1/conversations/${plainId}/attachments`, undefined, null),
    );
  });

  test("audit trail of the routes", async () => {
    recordRows(
      "http.audit",
      await auditRows(
        or(
          like(auditLog.action, "conversation.%"),
          like(auditLog.action, "tool_policy.%"),
          like(auditLog.action, "file.%"),
        ),
      ),
    );
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
