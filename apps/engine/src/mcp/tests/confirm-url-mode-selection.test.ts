// A2 — how a policy-confirmation row picks form vs URL delivery.
//
// A confirm row now carries BOTH a form shape and an `approval_url` fallback.
// The rule `deliverPendingNativeElicitationCore` must follow:
//   - form-capable client  → render the rich confirm FORM (never the link)
//   - client with no form   → deliver the approval_url as url-mode
//   - already-resolved row  → replay the settled decision synchronously,
//                             regardless of the client's form capability
//
// Credential/OAuth rows (`setup_url` / `authorization_url`) stay url-first and
// are already covered by the native-elicitation integration suite; this file
// pins ONLY the new `approval_url` branch.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { ElicitationResult } from "../../conversations/elicitation-bridge.ts";
import { getElicitation } from "../../conversations/elicitations.ts";
import { conversationElicitations, conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  deliverPendingNativeElicitationCore,
  type NativeDeliveryResult,
  type NativeElicitationTransport,
} from "../capabilities/conversation-native-elicitation.ts";

let ctx: TestDb;
let tenant_id: string;

const APPROVAL_URL = `https://engine.example/v1/tool-approvals/decide?grant=skag_${"a".repeat(24)}`;

/** Deterministic UUIDs — random ids are banned in tests (determinism gate). */
let uuidSeq = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, "0")}`;

beforeAll(async () => {
  ctx = await createTestDb("confirm_url_mode_selection");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-cums", display_name: "T-CUMS" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function principal(): ResolvedPrincipal {
  return {
    kind: "user",
    id: uuid(),
    tenant_id,
    roles: [],
    scopes: [],
  } as unknown as ResolvedPrincipal;
}

async function seedPendingConfirm(p: { lastError?: string }): Promise<string> {
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "awaiting_input" })
    .returning({ id: conversations.id });
  const [row] = await ctx.db
    .insert(conversationElicitations)
    .values({
      tenant_id,
      conversation_id: conv!.id,
      tool_name: "ask_user_confirm",
      summary: "confirm some_write",
      input: {
        kind: "confirm",
        question: "Policy requires confirmation before running some_write. Proceed?",
        commit_intent: {
          kind: "execute_confirmed_tool_call",
          payload: { tool: "some_write", approval_id: uuid() },
          description: "Run the gated tool.",
        },
        approval_url: APPROVAL_URL,
      },
      status: "pending",
      ...(p.lastError ? { delivery_last_error: p.lastError } : {}),
    })
    .returning({ id: conversationElicitations.id });
  return row!.id;
}

/** A transport whose arms record their invocation and resolve immediately. */
function recordingTransport(kinds: { form?: boolean; url?: boolean }): {
  transport: NativeElicitationTransport;
  formCalls: number;
  urlCalls: () => number;
  lastUrl: () => string | undefined;
} {
  let formCalls = 0;
  let urlCalls = 0;
  let lastUrl: string | undefined;
  const transport: NativeElicitationTransport = {};
  if (kinds.form) {
    transport.elicitForm = async (): Promise<ElicitationResult> => {
      formCalls += 1;
      return { action: "accept", content: { confirmed: true } };
    };
  }
  if (kinds.url) {
    transport.elicitUrl = async (params): Promise<ElicitationResult> => {
      urlCalls += 1;
      lastUrl = params.url;
      return { action: "accept" };
    };
  }
  return {
    transport,
    get formCalls() {
      return formCalls;
    },
    urlCalls: () => urlCalls,
    lastUrl: () => lastUrl,
  };
}

/** Run delivery and wait for the detached wire arm to settle (resume stub
 *  resolves a deferred). */
async function deliverAndSettle(
  id: string,
  transport: NativeElicitationTransport,
): Promise<{ resumeCalls: number }> {
  let resumeCalls = 0;
  let resolveResumed: () => void = () => {};
  const resumed = new Promise<void>((r) => {
    resolveResumed = r;
  });
  const pending = await getElicitation(tenant_id, id, ctx.db);
  if (!pending) throw new Error("seed elicitation missing");
  await deliverPendingNativeElicitationCore({
    db: ctx.db,
    principal: principal(),
    pending,
    nativeElicitation: transport,
    resume: async (): Promise<NativeDeliveryResult> => {
      resumeCalls += 1;
      resolveResumed();
      return { isError: false, content: [{ type: "text", text: "resumed" }] };
    },
  });
  // The wire arm is detached; the replay arm is synchronous. Either way, wait
  // briefly for a resume to land so the assertions are deterministic.
  await Promise.race([resumed, Bun.sleep(2_000)]);
  return { resumeCalls };
}

describe("confirm URL-mode selection (approval_url branch)", () => {
  test("form-capable client renders the FORM, never the approval link", async () => {
    const id = await seedPendingConfirm({});
    const rec = recordingTransport({ form: true, url: true });
    await deliverAndSettle(id, rec.transport);
    expect(rec.formCalls).toBeGreaterThanOrEqual(1);
    expect(rec.urlCalls()).toBe(0);
  });

  test("a client with no form capability delivers the approval_url as url-mode", async () => {
    const id = await seedPendingConfirm({});
    const rec = recordingTransport({ url: true }); // url only, no elicitForm
    await deliverAndSettle(id, rec.transport);
    expect(rec.urlCalls()).toBe(1);
    expect(rec.lastUrl()).toBe(APPROVAL_URL);
    expect(rec.formCalls).toBe(0);
  });

  test("an already-completed row replays synchronously and resumes — even on a form-capable, url-incapable client", async () => {
    const id = await seedPendingConfirm({ lastError: "url_completed" });
    const rec = recordingTransport({ form: true }); // form-capable, NOT url-capable
    const { resumeCalls } = await deliverAndSettle(id, rec.transport);
    // Neither wire arm fires: the settled URL interaction is replayed directly.
    expect(rec.formCalls).toBe(0);
    expect(rec.urlCalls()).toBe(0);
    expect(resumeCalls).toBe(1);
    const resolved = await getElicitation(tenant_id, id, ctx.db);
    expect(resolved?.output).toMatchObject({ confirmed: true });
  });
});
