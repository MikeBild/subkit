import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { issueBrowserSession } from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { setConfigKey } from "../../config/loader.ts";
import {
  apiKeys,
  conversationElicitations,
  conversations,
  mcpTasks,
  systemAccounts,
  toolApprovals,
} from "../../db/schema/index.ts";
import { sha256Hex } from "../../identity/api-key.ts";
import type { ConversationRunTurnJob } from "../../queue/queues.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { requestApproval } from "../../tools/approval.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

const nextApprovalId = createDeterministicUuidFactory(0x63706c);

let server: HttpTestServer;
let requester: ResolvedPrincipal;
let browserCookie: string;

const sent: Array<{
  queue: string;
  job: ConversationRunTurnJob;
  options: { id?: string } | undefined;
}> = [];
let acceptSend = true;

beforeAll(async () => {
  server = await createHttpTestServer("tool-approvals-completion", {
    appOptions: {
      boss: {
        send: async (queue: string, job: unknown, options?: { id?: string }) => {
          sent.push({ queue, job: job as ConversationRunTurnJob, options });
          return acceptSend ? (options?.id ?? null) : null;
        },
      } as never,
    },
  });
  await setConfigKey("server.public_base_url", server.baseUrl, { force: true });
  const login = await issueBrowserSession({
    db: server.db,
    tenantId: server.tenantId,
    userId: server.userId,
    redirectTo: server.baseUrl,
    via: "approval_portal_completion_test",
  });
  browserCookie = login.headers.get("set-cookie") ?? "";
  if (!browserCookie) throw new Error("browser session was not issued");
  await server.db
    .update(systemAccounts)
    .set({ role_id: await builtinRoleId(server.db, "admin") })
    .where(
      and(
        eq(systemAccounts.tenant_id, server.tenantId),
        eq(systemAccounts.id, server.systemAccountId),
      ),
    );
  const digest = sha256Hex("synthetic-local-approval-fixture");
  const [key] = await server.db
    .insert(apiKeys)
    .values({
      tenant_id: server.tenantId,
      system_account_id: server.systemAccountId,
      prefix: `approval-${server.systemAccountId}`,
      token_sha256: digest,
      scopes: ["*"],
    })
    .returning();
  if (!key) throw new Error("requester credential missing");
  requester = {
    provider: "api_key",
    kind: "system_account",
    id: server.systemAccountId,
    tenant_id: server.tenantId,
    roles: ["admin"],
    scopes: ["*"],
    auth_source: { kind: "api_key", api_key_id: key.id, credential_version: sha256Hex(digest) },
  };
}, 120_000);

afterAll(async () => {
  await server.cleanup();
}, 120_000);

async function seedParkedCall(): Promise<{
  approval_id: string;
  grant: string;
  conversation_id: string;
  elicitation_id: string;
}> {
  const approval_id = nextApprovalId();
  const { approval_url } = await requestApproval({
    db: server.db,
    principal: requester,
    approval_id,
    tool: "dry_run_workflow",
    surface: "chat",
    via: "chat",
    reason: "computed_from_input",
    execution_mode: "prod",
    args: { workflow: "radar-collect-raw", execute_writes: true },
    preview: { would_write: [{ step: "put_page", method: "PUT", url: "s3://radar/_probe/1" }] },
  });
  if (!approval_url) throw new Error("seed approval did not mint a portal link");

  const [conv] = await server.db
    .insert(conversations)
    .values({ tenant_id: server.tenantId, status: "awaiting_input" })
    .returning({ id: conversations.id });
  if (!conv) throw new Error("seed conversation failed");

  const [row] = await server.db
    .insert(conversationElicitations)
    .values({
      tenant_id: server.tenantId,
      conversation_id: conv.id,
      tool_name: "ask_user_confirm",
      summary: "Confirm dry_run_workflow (policy: confirm_before_execution)",
      input: {
        kind: "external_write",
        question: "Policy requires confirmation before running dry_run_workflow. Proceed?",
        commit_intent: {
          kind: "execute_confirmed_tool_call",
          payload: { tool: "dry_run_workflow", approval_id },
          description: "Run dry_run_workflow with the arguments the operator is approving.",
        },
      },
      status: "pending",
    })
    .returning({ id: conversationElicitations.id });
  if (!row) throw new Error("seed elicitation failed");

  return {
    approval_id,
    grant: new URL(approval_url).searchParams.get("grant") ?? "",
    conversation_id: conv.id,
    elicitation_id: row.id,
  };
}

async function decide(grant: string, decision: "approve" | "decline"): Promise<Response> {
  const headers = { cookie: browserCookie };
  const page = await fetch(
    `${server.baseUrl}/v1/tool-approvals/decide?grant=${encodeURIComponent(grant)}`,
    { headers },
  );
  const csrf_token = /name="csrf_token" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  return await fetch(`${server.baseUrl}/v1/tool-approvals/decide`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant, decision, csrf_token }).toString(),
  });
}

async function readElicitation(id: string) {
  const [row] = await server.db
    .select()
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, server.tenantId),
        eq(conversationElicitations.id, id),
      ),
    );
  if (!row) throw new Error("elicitation vanished");
  return row;
}

describe("approval portal — the decision owns its effect", () => {
  test("approving stages the answer and enqueues the resume, in the human's own request", async () => {
    sent.length = 0;
    const parked = await seedParkedCall();

    const started = Date.now(); // allow-wall-clock
    const res = await decide(parked.grant, "approve");
    const elapsed_ms = Date.now() - started; // allow-wall-clock

    expect(res.status).toBe(200);
    expect(elapsed_ms).toBeLessThan(5_000);
    const receipt = await res.text();
    expect(receipt).toContain("continuation was queued");
    expect(receipt).not.toContain("being carried out");

    const [approval] = await server.db
      .select()
      .from(toolApprovals)
      .where(eq(toolApprovals.id, parked.approval_id));
    expect(approval?.granted_at).not.toBeNull();
    expect(approval?.granted_via).toBe("portal");
    expect(approval?.consumed_at).toBeNull();
    expect(approval?.expires_at.getTime()).toBeGreaterThan(Date.now()); // allow-wall-clock

    const elicitation = await readElicitation(parked.elicitation_id);
    expect(elicitation.status).toBe("pending");
    expect(elicitation.output).toEqual({ confirmed: true });
    expect(elicitation.delivery_last_error).toBe("url_completed");

    const tasks = await server.db
      .select()
      .from(mcpTasks)
      .where(
        and(
          eq(mcpTasks.tenant_id, server.tenantId),
          eq(mcpTasks.conversation_id, parked.conversation_id),
        ),
      );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.kind).toBe("respond_elicitation");
    expect(tasks[0]?.request_source).toBe("portal");
    expect(tasks[0]?.job_id).toBe(sent[0]?.options?.id);
    expect(tasks[0]?.job_id).toBe(sent[0]?.job.attempt_id);
    expect(tasks[0]?.failure_reason).toBeNull();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.queue).toBe("conversation.run-turn");
    expect(sent[0]?.job).toMatchObject({
      tenant_id: server.tenantId,
      conversation_id: parked.conversation_id,
      elicitation_id: parked.elicitation_id,
      kind: "respond_elicitation",
      answer_channel: "portal",
      mcp_task_id: tasks[0]?.id,
    });

    expect(sent[0]?.job.principal).toMatchObject({
      kind: "system_account",
      id: server.systemAccountId,
      tenant_id: server.tenantId,
    });
    expect(tasks[0]?.actor_id).toBe(server.userId);
  });

  test("declining stages a refusal and resumes — never a silent timeout", async () => {
    sent.length = 0;
    const parked = await seedParkedCall();

    const res = await decide(parked.grant, "decline");
    expect(res.status).toBe(200);

    const [approval] = await server.db
      .select()
      .from(toolApprovals)
      .where(eq(toolApprovals.id, parked.approval_id));
    expect(approval?.declined_at).not.toBeNull();
    expect(approval?.granted_at).toBeNull();

    const elicitation = await readElicitation(parked.elicitation_id);
    expect(elicitation.output).toBeNull();
    expect(elicitation.delivery_last_error).toBe("url_failed");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.job.reason).toBe("user_declined");
  });

  test("a lost enqueue marks the task failed instead of leaving a turn that reads as working", async () => {
    sent.length = 0;
    acceptSend = false;
    try {
      const parked = await seedParkedCall();

      const res = await decide(parked.grant, "approve");
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("being carried out");

      const [approval] = await server.db
        .select()
        .from(toolApprovals)
        .where(eq(toolApprovals.id, parked.approval_id));
      expect(approval?.granted_at).not.toBeNull();

      const tasks = await server.db
        .select()
        .from(mcpTasks)
        .where(
          and(
            eq(mcpTasks.tenant_id, server.tenantId),
            eq(mcpTasks.conversation_id, parked.conversation_id),
          ),
        );
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.failure_reason).toBe("enqueue_failed");
    } finally {
      acceptSend = true;
    }
  });

  test("an approval with no paused conversation still grants, and promises nothing", async () => {
    sent.length = 0;
    const approval_id = nextApprovalId();
    const { approval_url } = await requestApproval({
      db: server.db,
      principal: requester,
      approval_id,
      tool: "wf_send_report",
      surface: "mcp",
      via: "mcp",
      reason: "held_writes",
      execution_mode: "dev",
      args: { workflow: "send-report" },
      preview: { would_write: [{ step: "send", method: "POST", url: "https://mail.test/send" }] },
    });
    const grant = new URL(approval_url ?? "").searchParams.get("grant") ?? "";

    const res = await decide(grant, "approve");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(">Approved</h1>");
    expect(body).not.toContain("being carried out");
    expect(sent).toHaveLength(0);
  });
});
