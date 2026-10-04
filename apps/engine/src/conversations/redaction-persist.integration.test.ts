import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
  tenants,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { createElicitation, resolveElicitation } from "./elicitations.ts";
import { appendMessage, buildModelMessages } from "./persist.ts";
import { ELICITATION_REDACTED_MARKER } from "./tools/ask-user/redact-answer.ts";

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

describe("appendMessage — base64 alphabet persists verbatim", () => {
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
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain("***REDACTED");
  });
});

describe("buildModelMessages — base64 alphabet in user message replays byte-identical", () => {
  test("a user message with the base64 alphabet round-trips through buildModelMessages verbatim", async () => {
    if (skip) return;
    const conv_id = await makeConversation();
    const userText = `Please build a Gmail encoder. The base64 alphabet is: ${BASE64_ALPHABET}`;
    await appendMessage(ctx.db, tenant_id, conv_id, "user", { text: userText });

    const msgs = await buildModelMessages(ctx.db, tenant_id, conv_id);
    const userMsgs = msgs.filter((m) => m.role === "user");
    const allText = userMsgs
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join(" ");
    expect(allText).toContain(BASE64_ALPHABET);
    expect(allText).not.toContain("***REDACTED");
  });
});

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

describe("resolveElicitation — secret form answers persist redacted", () => {
  test("a password field's answer is stored as the marker, not the secret", async () => {
    if (skip) return;
    const conv_id = await makeConversation();
    const secret = "hunter2-super-secret";
    const elicitation = await createElicitation(
      {
        tenant_id,
        conversation_id: conv_id,
        tool_call_id: null,
        actor_id: null,
        tool_name: "ask_user_form",
        summary: "Enter API credentials",
        input: {
          kind: "ask_user_form",
          fields: [
            { name: "base_url", label: "Base URL", type: "text" },
            { name: "api_token", label: "API token", type: "password" },
          ],
        },
      },
      ctx.db,
    );

    await resolveElicitation(
      {
        tenant_id,
        id: elicitation.id,
        output: { values: { base_url: "https://api.example.com", api_token: secret } },
        decided_by: null,
      },
      ctx.db,
    );

    const [row] = await ctx.db
      .select({ output: conversationElicitations.output })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation.id));
    const stored = row?.output as { values: Record<string, string> };
    expect(stored.values.api_token).toBe(ELICITATION_REDACTED_MARKER);
    expect(stored.values.base_url).toBe("https://api.example.com");
    expect(JSON.stringify(stored)).not.toContain(secret);
  });

  test("a form with no secret fields persists its answer verbatim", async () => {
    if (skip) return;
    const conv_id = await makeConversation();
    const elicitation = await createElicitation(
      {
        tenant_id,
        conversation_id: conv_id,
        tool_call_id: null,
        actor_id: null,
        tool_name: "ask_user_form",
        summary: "Pick a name",
        input: { kind: "ask_user_form", fields: [{ name: "name", label: "Name", type: "text" }] },
      },
      ctx.db,
    );
    await resolveElicitation(
      { tenant_id, id: elicitation.id, output: { values: { name: "acme" } }, decided_by: null },
      ctx.db,
    );
    const [row] = await ctx.db
      .select({ output: conversationElicitations.output })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitation.id));
    expect((row!.output as { values: Record<string, string> }).values.name).toBe("acme");
  });
});

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

    const [convB] = await ctx.db
      .insert(conversations)
      .values({ tenant_id: tB.id, status: "active" })
      .returning({ id: conversations.id });
    if (!convB) throw new Error("tenant B conversation seed failed");
    await appendMessage(ctx.db, tB.id, convB.id, "user", { text: "tenant B message" });

    const msgs = await buildModelMessages(ctx.db, tB.id, conv_id);
    const userMsgs = msgs.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(0);
    expect(userMsgs.every((m) => !JSON.stringify(m.content).includes("tenant A message"))).toBe(
      true,
    );
  });
});

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

    expect(readExpr.endsWith(`${BASE64_ALPHABET}";`)).toBe(false);
    expect(readExpr.includes(BASE64_ALPHABET)).toBe(true);
  });
});
