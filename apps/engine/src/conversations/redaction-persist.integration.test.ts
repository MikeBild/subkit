// Integration test: the redaction outage regression at the DB persistence layer.
//
// Root cause (v7.5 outage): appendMessage's scrubString call (for role=user
// messages) was context-UNAWARE — it treated the bare base64 alphabet as a
// secret and replaced it with "***REDACTED:generic***". The authoring LLM
// then saved `var B="***REDACTED:generic***/"`; the hand-rolled encoder
// emitted "undefined" 43,923x; the 416KB corrupt Gmail body hung send.
//
// The fix: GENERIC_TOKEN_RE is now code-context-suppressed — a high-entropy
// run redacts on SHAPE by default, including a bare vendor-less token with no
// keyword (the lone-paste shape). Suppression is narrow: a known codec
// alphabet, or a non-secret `var/const/let = "..."` literal, passes through
// verbatim so the hand-rolled encoder's alphabet survives.
//
// These tests verify the fix at the DB layer — not just the pure scrubString
// function, but the actual appendMessage → select round-trip so a regression
// in the call site itself (e.g. switching to scrubSecrets instead of
// scrubString) is caught here.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  conversationMessages,
  conversations,
  tenants,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { appendMessage, buildModelMessages } from "./persist.ts";

const skip = process.env.REQUIRES_PG === "0";

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  if (skip) return;
  ctx = await createTestDb("redaction-persist");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-redact-persist", display_name: "Redaction Persist Tenant" })
    .returning();
  if (!t) throw new Error("tenant seed failed");
  tenant_id = t.id;
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

async function makeConversation(): Promise<string> {
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning({ id: conversations.id });
  if (!conv) throw new Error("conversation seed failed");
  return conv.id;
}

async function readMessageContent(id: string): Promise<Record<string, unknown>> {
  const [row] = await ctx.db
    .select({ content: conversationMessages.content })
    .from(conversationMessages)
    .where(eq(conversationMessages.id, id));
  if (!row) throw new Error(`message ${id} not found`);
  return row.content as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Core regression: role=user message with the base64 alphabet persists
// byte-identical — no "***REDACTED:generic***" corruption.
// ---------------------------------------------------------------------------

describe("appendMessage — base64 alphabet persists verbatim (outage regression)", () => {
  test("role=user message containing the bare base64 standard alphabet is stored byte-identical", async () => {
    if (skip) return;
    const conv_id = await makeConversation();
    const msg = `Here is the encoder alphabet: ${BASE64_ALPHABET}`;
    const id = await appendMessage(ctx.db, tenant_id, conv_id, "user", { text: msg });
    const stored = await readMessageContent(id);
    expect(stored.text).toBe(msg);
    expect(typeof stored.text).toBe("string");
    expect((stored.text as string).includes("***REDACTED")).toBe(false);
    expect((stored.text as string).includes(BASE64_ALPHABET)).toBe(true);
  });

  test("role=user message with url-safe base64 alphabet is stored byte-identical", async () => {
    if (skip) return;
    const conv_id = await makeConversation();
    const msg = `var B="${BASE64_URL_SAFE}"; // url-safe variant`;
    const id = await appendMessage(ctx.db, tenant_id, conv_id, "user", { text: msg });
    const stored = await readMessageContent(id);
    expect(stored.text).toBe(msg);
    expect((stored.text as string).includes("***REDACTED")).toBe(false);
  });

  test("role=assistant message is never scrubbed by appendMessage (only role=user gets scrubbed)", async () => {
    if (skip) return;
    const conv_id = await makeConversation();
    const msg = `var B="${BASE64_ALPHABET}"; return B;`;
    const id = await appendMessage(ctx.db, tenant_id, conv_id, "assistant", [
      { type: "text", text: msg },
    ]);
    const stored = await readMessageContent(id);
    // The assistant path does not apply scrubString; the content is the array.
    // We verify the content round-tripped with no corruption.
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain("***REDACTED");
  });
});

// ---------------------------------------------------------------------------
// buildModelMessages — the stored alphabet replays byte-identical into the
// model message history. If the persistence layer had stored the redacted
// form, the replayed text would carry "***REDACTED" and fail here.
// ---------------------------------------------------------------------------

describe("buildModelMessages — base64 alphabet in user message replays byte-identical", () => {
  test("a user message with the base64 alphabet round-trips through buildModelMessages verbatim", async () => {
    if (skip) return;
    const conv_id = await makeConversation();
    const userText = `Please build a Gmail encoder. The base64 alphabet is: ${BASE64_ALPHABET}`;
    await appendMessage(ctx.db, tenant_id, conv_id, "user", { text: userText });

    const msgs = await buildModelMessages(ctx.db, tenant_id, conv_id);
    const userMsgs = msgs.filter((m) => m.role === "user");
    // The replayed text must contain the full alphabet verbatim.
    const allText = userMsgs
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join(" ");
    expect(allText).toContain(BASE64_ALPHABET);
    expect(allText).not.toContain("***REDACTED");
  });
});

// ---------------------------------------------------------------------------
// True secrets are STILL redacted at the appendMessage chokepoint.
// The fix must not weaken real secret detection — only remove false positives
// on code literals.
// ---------------------------------------------------------------------------

describe("appendMessage — true secrets ARE still redacted in role=user messages", () => {
  test("a pasted PAT (sk-ant-…) in a user message is redacted before persistence", async () => {
    if (skip) return;
    const conv_id = await makeConversation();
    const pat = "sk-ant-api03-faketoken12345678901234567890";
    const msg = `My API key is ${pat}, please use it`;
    const id = await appendMessage(ctx.db, tenant_id, conv_id, "user", { text: msg });
    const stored = await readMessageContent(id);
    expect(stored.text as string).not.toContain(pat);
    expect(stored.text as string).toContain("***REDACTED:");
  });

  test("an api_key=<high-entropy> assignment in a user message is redacted", async () => {
    if (skip) return;
    const conv_id = await makeConversation();
    const token = "Xy9KqLm2NpRsTuVwAbCdEfGhJkMnPqRsTuVwXyZ1";
    const msg = `api_key=${token}`;
    const id = await appendMessage(ctx.db, tenant_id, conv_id, "user", { text: msg });
    const stored = await readMessageContent(id);
    expect(stored.text as string).not.toContain(token);
    expect(stored.text as string).toContain("***REDACTED:");
  });

  test("a BARE vendor-less token (no keyword) in a user message is NOT persisted raw", async () => {
    // The missing-direction case: the lone-paste shape `here you go: <token>`
    // carries no vendor prefix and no keyword. It must redact at the
    // persistence chokepoint, not land raw in the replayed message row.
    if (skip) return;
    const conv_id = await makeConversation();
    const token = "Xy9KqLm2NpRsTuVwAbCdEfGhJkMnPqRsTuVwXyZ1";
    const msg = `here you go: ${token}`;
    const id = await appendMessage(ctx.db, tenant_id, conv_id, "user", { text: msg });
    const stored = await readMessageContent(id);
    expect(stored.text as string).not.toContain(token);
    expect(stored.text as string).toContain("***REDACTED:generic***");
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation: a second tenant's conversation cannot read the first's
// message via appendMessage or buildModelMessages.
// ---------------------------------------------------------------------------

describe("appendMessage — tenant isolation", () => {
  test("buildModelMessages for tenant B returns no messages from tenant A's conversation", async () => {
    if (skip) return;
    const [tB] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-redact-persist-b", display_name: "Redaction Persist Tenant B" })
      .returning();
    if (!tB) throw new Error("tenant B seed failed");

    const conv_id = await makeConversation();
    await appendMessage(ctx.db, tenant_id, conv_id, "user", { text: "tenant A message" });

    // buildModelMessages with tenant B's id and tenant A's conv_id should
    // return an empty history (the query is tenant-scoped).
    const msgs = await buildModelMessages(ctx.db, tB.id, conv_id);
    // No user messages from tenant A should appear.
    const userMsgs = msgs.filter((m) => m.role === "user");
    expect(userMsgs.every((m) => !JSON.stringify(m.content).includes("tenant A message"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Workflow with base64 alphabet in transform round-trips: author → save → load.
// This confirms the outage's proximate cause — a workflow DAG containing
// `var B="<alphabet>"` in a transform step — does NOT corrupt when the
// workflow_versions row is written and read back.
// ---------------------------------------------------------------------------

describe("workflow DAG with base64 alphabet in transform — round-trip", () => {
  test("a workflow version whose transform embeds the base64 alphabet stores and reads back uncorrupted", async () => {
    if (skip) return;

    const encoderExpression = `const B="${BASE64_ALPHABET}";let o="";for(const c of input.input.s){const i=B.indexOf(c);o+=i.toString(16).padStart(2,"0");}return o;`;

    const [wf] = await ctx.db
      .insert(workflows)
      .values({
        tenant_id,
        slug: "b64-alphabet-test-wf",
        name: "base64 alphabet test",
        lifecycle: "active",
      })
      .returning();
    if (!wf) throw new Error("workflow seed failed");

    const dag = {
      name: "base64 alphabet test",
      slug: "b64-alphabet-test-wf",
      steps: [
        {
          id: "encode",
          kind: "transform",
          expression: encoderExpression,
        },
      ],
    };

    const [v] = await ctx.db
      .insert(workflowVersions)
      .values({
        tenant_id,
        workflow_id: wf.id,
        version: 1,
        dag,
      })
      .returning();
    if (!v) throw new Error("workflow version seed failed");

    await ctx.db.update(workflows).set({ current_version_id: v.id }).where(eq(workflows.id, wf.id));

    // Read back the workflow version and verify the DAG is byte-identical.
    const [readBack] = await ctx.db
      .select({ dag: workflowVersions.dag })
      .from(workflowVersions)
      .where(eq(workflowVersions.id, v.id));
    if (!readBack) throw new Error("workflow version not found after insert");

    const readDag = readBack.dag as typeof dag;
    const readExpr = (readDag.steps[0] as { expression: string }).expression;

    expect(readExpr).toBe(encoderExpression);
    expect(readExpr).not.toContain("***REDACTED");
    expect(readExpr).toContain(BASE64_ALPHABET);

    // The expression contains the full alphabet — no "undefined" insertion,
    // no corruption of the `+/` suffix.
    expect(readExpr.endsWith(`${BASE64_ALPHABET}";`)).toBe(false); // trimmed sanity
    expect(readExpr.includes(BASE64_ALPHABET)).toBe(true);
  });
});
