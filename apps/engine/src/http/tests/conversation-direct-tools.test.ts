import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { appendSnapshot, loadDraft } from "../../conversations/draft.ts";
import { createElicitation, resolveElicitation } from "../../conversations/elicitations.ts";
import type { DraftDocument } from "../../conversations/types.ts";
import {
  conversationDraftSnapshots,
  conversationMessages,
  conversations,
  conversationToolCalls,
} from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let conversation_id: string;
let empty_conversation_id: string;

function makeWorkflowDraft(): DraftDocument {
  return {
    workflow: {
      name: "shape-flow",
      slug: "shape-flow",
      steps: [
        {
          id: "fetch",
          kind: "transform",
          language: "javascript",
          expression: "return input.input;",
        },
        {
          id: "shape",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.fetch.data;",
        },
      ],
    },
    latest_preview: {
      ok: true,
      summary: "preview seeded for test fixture",
      step_traces: [
        { step_id: "fetch", kind: "transform", status: "succeeded", output_preview: { value: 1 } },
        { step_id: "shape", kind: "transform", status: "succeeded", output_preview: { shaped: 1 } },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
  } as any;
}

beforeAll(async () => {
  srv = await createHttpTestServer("conv-direct-tools");
  const [c] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "active" })
    .returning();
  conversation_id = c!.id;
  await appendSnapshot(srv.tenantId, conversation_id, makeWorkflowDraft(), srv.db);
  const [empty] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "active" })
    .returning();
  empty_conversation_id = empty!.id;
});

afterAll(async () => {
  await srv.cleanup();
});

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${srv.apiKey}`,
      "content-type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${srv.baseUrl}${path}`, init);
}

interface DirectResult {
  ok: boolean;
  tool: string;
  tool_call_id: string;
  data: Record<string, unknown>;
  logs: unknown[];
  diffs: unknown[];
}

describe("conversation direct tool routes", () => {
  test("POST /draft/patch applies a patch and persists the loop-parity rows", async () => {
    const res = await api("POST", `/v1/conversations/${conversation_id}/draft/patch`, {
      patches: [
        { op: "replace", path: "/steps/0/id", value: "load" },
        { op: "replace", path: "/steps/1/expression", value: "return input.scope.load.data;" },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DirectResult;
    expect(body.ok).toBe(true);
    expect(body.tool).toBe("edit_workflow_patch");

    const draft = await loadDraft(srv.tenantId, conversation_id, srv.db);
    const steps =
      (draft as unknown as { workflow?: { steps?: Array<{ id: string }> } }).workflow?.steps ?? [];
    expect(steps[0]?.id).toBe("load");

    const calls = await srv.db
      .select()
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, srv.tenantId),
          eq(conversationToolCalls.conversation_id, conversation_id),
        ),
      )
      .orderBy(desc(conversationToolCalls.created_at))
      .limit(1);
    expect(calls[0]?.tool).toBe("edit_workflow_patch");
    expect(calls[0]?.output).not.toBeNull();

    const msgs = await srv.db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.tenant_id, srv.tenantId),
          eq(conversationMessages.conversation_id, conversation_id),
          eq(conversationMessages.role, "tool"),
        ),
      );
    expect(msgs.length).toBeGreaterThanOrEqual(1);

    const snapshots = await srv.db
      .select()
      .from(conversationDraftSnapshots)
      .where(
        and(
          eq(conversationDraftSnapshots.tenant_id, srv.tenantId),
          eq(conversationDraftSnapshots.conversation_id, conversation_id),
        ),
      );
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
  });

  test("GET /draft/snapshots lists snapshots; POST restore rolls back", async () => {
    const list = await api("GET", `/v1/conversations/${conversation_id}/draft/snapshots`);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as DirectResult;
    expect(listBody.ok).toBe(true);
    expect(listBody.tool).toBe("list_draft_snapshots");
    const snapshots = (listBody.data as { snapshots: Array<{ id: string }> }).snapshots;
    expect(snapshots.length).toBeGreaterThanOrEqual(1);

    const restore = await api(
      "POST",
      `/v1/conversations/${conversation_id}/draft/snapshots/restore`,
      {},
    );
    expect(restore.status).toBe(200);
    const restoreBody = (await restore.json()) as DirectResult;
    expect(restoreBody.ok).toBe(true);
    expect(restoreBody.tool).toBe("restore_draft_snapshot");
  });

  test("POST /preview on an empty draft returns the blocked envelope, not a 5xx", async () => {
    const res = await api("POST", `/v1/conversations/${empty_conversation_id}/preview`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as DirectResult;
    expect(body.ok).toBe(false);
    expect(body.tool).toBe("dry_run_workflow");
  });

  test("POST /preview with step_id dispatches dry_run_step", async () => {
    const res = await api("POST", `/v1/conversations/${empty_conversation_id}/preview`, {
      step_id: "nope",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DirectResult;
    expect(body.tool).toBe("dry_run_step");
    expect(body.ok).toBe(false);
  });

  test("POST /probe without a connector draft returns the tool's typed failure", async () => {
    const res = await api("POST", `/v1/conversations/${empty_conversation_id}/probe`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as DirectResult;
    expect(body.tool).toBe("probe_connector_draft");
    expect(body.ok).toBe(false);
  });

  test("invalid args (empty patch array) return 400", async () => {
    const res = await api("POST", `/v1/conversations/${conversation_id}/draft/patch`, {
      patches: [],
    });
    expect(res.status).toBe(400);
  });

  test("unknown conversation returns 404", async () => {
    // allow-random: the lookup must miss for a 404.
    const res = await api("POST", `/v1/conversations/${crypto.randomUUID()}/preview`, {});
    expect(res.status).toBe(404);
  });

  test("a pending elicitation blocks direct invocation with 409", async () => {
    const elicitation = await createElicitation(
      {
        tenant_id: srv.tenantId,
        conversation_id,
        tool_call_id: null,
        tool_name: "ask_user_text",
        summary: "test pending dialog",
        input: { question: "?" },
        actor_id: null,
      },
      srv.db,
    );
    try {
      const res = await api("POST", `/v1/conversations/${conversation_id}/preview`, {});
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; details?: Record<string, unknown> };
      expect(body.details?.pending_elicitation).toBeDefined();
    } finally {
      await resolveElicitation(
        {
          tenant_id: srv.tenantId,
          id: elicitation.id,
          output: { text: "done" },
          decided_by: null,
        },
        srv.db,
      );
    }
  });
});
