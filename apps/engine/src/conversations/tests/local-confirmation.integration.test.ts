import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import type { LocalConfirmation } from "@shared/device/confirmation.ts";
import { RUNNER_ASSERTION_AUDIENCE } from "@shared/device/runner-wire.ts";
import { and, eq } from "drizzle-orm";
import {
  issueBrowserSession,
  signBrowserCsrf,
  verifyBrowserSession,
} from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  auditLog,
  conversationElicitations,
  conversationToolCalls,
  events,
  taskRuns,
  tasks,
  users,
} from "../../db/schema/index.ts";
import {
  LocalConfirmationExpiredError,
  LocalConfirmationForbiddenError,
} from "../../devices/confirmation-errors.ts";
import type {
  LocalConfirmationOutcome,
  LocalConfirmationPort,
} from "../../devices/confirmation-port.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  type HttpTestServer,
} from "../../http/tests/setup.ts";
import { createOrReuseDesktopInstallation } from "../../identity/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { readOwnConversations } from "../../operator/attention-conversations.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { opened } from "../../test-helpers/elicitations.ts";
import { seedConversation } from "../../test-helpers/seed.ts";
import { expireDueElicitations } from "../elicitation-expiry.ts";
import { getElicitation, resolveElicitation } from "../elicitations.ts";
import { type LocalConfirmationRequest, requestLocalConfirmation } from "../local-confirmation.ts";
import { respondElicitationForTest } from "./setup.ts";

let server: HttpTestServer;
let owner_id = "";

const COMMAND_ID = "c".repeat(64);
const BINDING_HASH = "b".repeat(64);
const DEVICE_ID = "d1000000-0000-4000-8000-0000000000e6";

beforeAll(async () => {
  testEnv.LLM_PROVIDER = "mock";
  resetMockProvider();
  server = await createHttpTestServer("local-confirmations");
  const [row] = await server.db
    .insert(users)
    .values({
      tenant_id: server.tenantId,
      email: "owner-local@test.local",
      role_id: await builtinRoleId(server.db, "member"),
    })
    .returning({ id: users.id });
  if (!row) throw new Error("owner fixture missing");
  owner_id = row.id;
}, 120_000);

afterAll(async () => {
  if (server) await server.cleanup();
}, 30_000);

function recordingPort(): LocalConfirmationPort & { seen: LocalConfirmationOutcome[] } {
  const seen: LocalConfirmationOutcome[] = [];
  return {
    seen,
    settled: async (outcome) => {
      seen.push(outcome);
    },
  };
}

function browserPrincipal(id: string, roles: string[]): ResolvedPrincipal {
  return {
    provider: "browser_session",
    kind: "user",
    id,
    tenant_id: server.tenantId,
    roles,
    auth_source: { kind: "browser_session", session_id: `session-${id}` },
  };
}

async function askedStep(
  conversation_id: string,
  extra: Partial<LocalConfirmationRequest> = {},
): Promise<{ tool_call_id: string; elicitation_id: string; confirmation: LocalConfirmation }> {
  const [call] = await server.db
    .insert(conversationToolCalls)
    .values({
      tenant_id: server.tenantId,
      conversation_id,
      tool: "browser_press",
      input: { ref: "e12" },
      output: null,
    })
    .returning({ id: conversationToolCalls.id });
  if (!call) throw new Error("tool call fixture missing");
  const asked = opened(
    await requestLocalConfirmation(server.db, {
      tenant_id: server.tenantId,
      conversation_id,
      tool_call_id: call.id,
      parent_message_id: null,
      actor_id: owner_id,
      tool: "browser_press",
      args: { ref: "e12" },
      question: "„Zahlungspflichtig bestellen“ auf shop.example drücken?",
      device: {
        device_id: DEVICE_ID,
        capability: "browser",
        target: "„Zahlungspflichtig bestellen“ auf shop.example",
        command_id: COMMAND_ID,
        binding_hash: BINDING_HASH,
      },
      requested_at: new Date(getTestNow()),
      limits: [],
      ...extra,
    }),
  );
  return { tool_call_id: call.id, ...asked };
}

async function toolCall(id: string) {
  const [row] = await server.db
    .select()
    .from(conversationToolCalls)
    .where(eq(conversationToolCalls.id, id))
    .limit(1);
  if (!row) throw new Error("tool call missing");
  return row;
}

async function auditFor(action: string, resource_id: string) {
  return server.db
    .select({ metadata: auditLog.metadata, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, server.tenantId),
        eq(auditLog.action, action as never),
        eq(auditLog.resource_id, resource_id),
      ),
    );
}

describe("a local step that must ask uses the chat confirmation", () => {
  test("in chat the owner grants it, the step continues and the command gets its confirmation", async () => {
    const conversation = await seedConversation(server.db, {
      tenant_id: server.tenantId,
      owner_id,
    });
    const step = await askedStep(conversation.id);
    const requested = Date.parse(step.confirmation.deadline_at) - getTestNow();
    expect(requested).toBeGreaterThan(14 * 60_000);
    expect(requested).toBeLessThanOrEqual(15 * 60_000);

    const pending = await toolCall(step.tool_call_id);
    expect(pending.confirmation_state).toBe("proposed");
    expect(pending.confirmation_data).toMatchObject({ device: step.confirmation });
    const card = await getElicitation(server.tenantId, step.elicitation_id, server.db);
    expect(card?.tool_name).toBe("ask_user_confirm");
    expect(card?.input).toMatchObject({ kind: "local_confirmation", device: step.confirmation });
    const [expiry] = await server.db
      .select({ expires_at: conversationElicitations.expires_at })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, step.elicitation_id));
    expect(expiry?.expires_at.toISOString()).toBe(step.confirmation.deadline_at);
    const [event] = await server.db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(eq(events.tenant_id, server.tenantId), eq(events.type, "local.confirmation_requested")),
      );
    expect(event?.payload).toMatchObject({
      confirmation_id: step.tool_call_id,
      device_id: DEVICE_ID,
      command_id: COMMAND_ID,
    });

    getMockProvider().setConversePlan(conversation.id, [{ text: "Bestellt." }]);
    const port = recordingPort();
    const outcome = await respondElicitationForTest(
      {
        tenant_id: server.tenantId,
        conversation_id: conversation.id,
        elicitation_id: step.elicitation_id,
        actor_id: owner_id,
        principal: browserPrincipal(owner_id, ["member"]),
        output: { confirmed: true },
        local_confirmations: port,
        now: new Date(getTestNow() + 60_000),
      },
      server.db,
    );
    expect(outcome.result.status).not.toBe("awaiting_input");

    const granted = await toolCall(step.tool_call_id);
    expect(granted.confirmation_state).toBe("confirmed");
    expect(granted.confirmation_data).toMatchObject({ device: step.confirmation });
    expect(port.seen).toEqual([
      {
        tenant_id: server.tenantId,
        confirmation_id: step.tool_call_id,
        confirmation: step.confirmation,
        state: "granted",
      },
    ]);
    const [audit] = await auditFor("local_confirmation.granted", step.tool_call_id);
    expect(audit?.actor_id).toBe(owner_id);
    expect(audit?.metadata).toMatchObject({
      confirmation_id: step.tool_call_id,
      command_id: COMMAND_ID,
      binding_hash: BINDING_HASH,
      device_id: DEVICE_ID,
    });
  });

  test("in a task run nobody confirms, the step fails and nothing was sent or changed", async () => {
    const [task] = await server.db
      .insert(tasks)
      .values({
        locale: "de",
        tenant_id: server.tenantId,
        name: "Bestellung",
        owner_id,
        goal: "Bestell das Papier nach",
        done_when: "Die Bestellung ist aufgegeben.",
        plan: { title: "Bestellung", goal: "Bestell das Papier nach", steps: [] },
        bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
        environment: "prod",
        fingerprint: "f".repeat(64),
      })
      .returning({ id: tasks.id });
    if (!task) throw new Error("task fixture missing");
    const conversation = await seedConversation(server.db, {
      tenant_id: server.tenantId,
      owner_id,
    });
    const requested_at = new Date("2026-01-05T09:00:00.000Z");
    const [run] = await server.db
      .insert(taskRuns)
      .values({
        tenant_id: server.tenantId,
        task_id: task.id,
        task_revision: 1,
        fingerprint: "f".repeat(64),
        conversation_id: conversation.id,
        trigger: "cron",
        started_by: null,
        state: "running",
        deadline_at: new Date("2026-01-05T09:05:00.000Z"),
        trace_id: "e".repeat(32),
      })
      .returning({ id: taskRuns.id });
    if (!run) throw new Error("task run fixture missing");
    const step = await askedStep(conversation.id, { requested_at });
    expect(step.confirmation.deadline_at).toBe("2026-01-05T09:05:00.000Z");

    const late = respondElicitationForTest(
      {
        tenant_id: server.tenantId,
        conversation_id: conversation.id,
        elicitation_id: step.elicitation_id,
        actor_id: owner_id,
        principal: browserPrincipal(owner_id, ["member"]),
        output: { confirmed: true },
        now: new Date("2026-01-05T09:05:00.000Z"),
      },
      server.db,
    );
    await expect(late).rejects.toBeInstanceOf(LocalConfirmationExpiredError);

    const port = recordingPort();
    const tally = { expired_count: 0, completed_count: 0 };
    await expireDueElicitations(tally, "local-confirmation-tick", server.db, { local: port });
    expect(tally.expired_count).toBeGreaterThanOrEqual(1);

    const failed = await toolCall(step.tool_call_id);
    expect(failed.confirmation_state).toBe("expired");
    expect(failed.outcome).toBe("expired");
    expect(failed.output).toMatchObject({
      ok: false,
      reason: "local_confirmation_expired",
      message: {
        de: "Es wurde nichts gesendet oder geändert.",
        en: "Nothing was sent or changed.",
      },
    });
    expect(failed.confirmation_data).toMatchObject({ device: step.confirmation });
    const card = await getElicitation(server.tenantId, step.elicitation_id, server.db);
    expect(card?.status).toBe("timeout");
    expect(port.seen).toEqual([
      {
        tenant_id: server.tenantId,
        confirmation_id: step.tool_call_id,
        confirmation: step.confirmation,
        state: "expired",
      },
    ]);
    expect(await auditFor("local_confirmation.granted", step.tool_call_id)).toHaveLength(0);
  });

  test("someone else, even an admin, and the owner outside a session are refused", async () => {
    const conversation = await seedConversation(server.db, {
      tenant_id: server.tenantId,
      owner_id,
    });
    const step = await askedStep(conversation.id);
    const attempt = (principal: ResolvedPrincipal, actor_id: string) =>
      respondElicitationForTest(
        {
          tenant_id: server.tenantId,
          conversation_id: conversation.id,
          elicitation_id: step.elicitation_id,
          actor_id,
          principal,
          output: { confirmed: true },
          now: new Date(getTestNow() + 60_000),
        },
        server.db,
      );
    const admin = attempt(browserPrincipal(server.userId, ["admin"]), server.userId);
    await expect(admin).rejects.toMatchObject({ status: 404, code: "not_found" });
    const withKey: ResolvedPrincipal = {
      ...browserPrincipal(owner_id, ["member"]),
      auth_source: { kind: "api_key", api_key_id: "k1", credential_version: "1" },
      api_key_id: "k1",
    };
    await expect(attempt(withKey, owner_id)).rejects.toMatchObject({
      refusal: "no_browser_session",
    });
    await expect(
      resolveElicitation(
        {
          tenant_id: server.tenantId,
          id: step.elicitation_id,
          output: { confirmed: true },
          decided_by: { kind: "user", id: owner_id },
        },
        server.db,
      ),
    ).rejects.toBeInstanceOf(LocalConfirmationForbiddenError);

    const card = await getElicitation(server.tenantId, step.elicitation_id, server.db);
    expect(card?.status).toBe("pending");
    expect((await toolCall(step.tool_call_id)).confirmation_state).toBe("proposed");
    expect(await auditFor("local_confirmation.granted", step.tool_call_id)).toHaveLength(0);
    const owned = await readOwnConversations(server.db, browserPrincipal(owner_id, ["member"]));
    expect(owned.find((c) => c.resource?.id === conversation.id)?.item).toMatchObject({
      class: "decide",
      kind: "local_confirmation",
      reason: "local_confirmation_needed",
      deadline: step.confirmation.deadline_at,
      actions: [{ verb: "answer", permission: "local:confirm" }],
    });

    const other = await browserSessionHeaders(server, server.userId);
    const response = await fetch(
      `${server.baseUrl}/v1/conversations/${conversation.id}/tool-calls/${step.tool_call_id}/respond`,
      { method: "POST", headers: other, body: JSON.stringify({ output: { confirmed: true } }) },
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("not_found");
  });

  test("a runner token never confirms, the owner's desktop session does", async () => {
    const { installation } = await createOrReuseDesktopInstallation(
      server.db,
      server.tenantId,
      owner_id,
      { device_id: DEVICE_ID, device_label: "Laptop (Owner)" },
    );
    const issued = await issueBrowserSession({
      db: server.db,
      tenantId: server.tenantId,
      userId: owner_id,
      installationId: installation.id,
      redirectTo: `/cockpit/i/${installation.id}/`,
      via: "desktop_login",
    });
    const cookie = (issued.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const payload = await verifyBrowserSession(
      decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)),
    );
    if (!payload) throw new Error("desktop session was not issued");
    const desktop = {
      cookie,
      "x-subkit-csrf": await signBrowserCsrf(payload),
      "content-type": "application/json",
    };
    const api = `${server.baseUrl}/cockpit/i/${installation.id}/api`;
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const enrolled = await fetch(`${api}/v1/devices/runner/enroll`, {
      method: "POST",
      headers: desktop,
      body: JSON.stringify({
        public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
        runner_version: "11.3.0",
      }),
    });
    expect(enrolled.status).toBe(201);
    const { device_runner_id } = (await enrolled.json()) as { device_runner_id: string };
    const access_token = await runnerToken(device_runner_id, privateKey);

    const conversation = await seedConversation(server.db, {
      tenant_id: server.tenantId,
      owner_id,
    });
    const step = await askedStep(conversation.id);
    const response = await fetch(
      `${server.baseUrl}/v1/conversations/${conversation.id}/tool-calls/${step.tool_call_id}/respond`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
        body: JSON.stringify({ output: { confirmed: true } }),
      },
    );
    expect(response.status).toBe(403);
    const card = await getElicitation(server.tenantId, step.elicitation_id, server.db);
    expect(card?.status).toBe("pending");
    expect((await toolCall(step.tool_call_id)).confirmation_state).toBe("proposed");

    const detail = await fetch(`${api}/v1/conversations/${conversation.id}`, { headers: desktop });
    expect(detail.status).toBe(200);
    const shown = (await detail.json()) as {
      resume_summary: {
        pending_approval: { expires_at: string; prompt: { kind: string; device: unknown } };
      };
    };
    expect(shown.resume_summary.pending_approval).toMatchObject({
      prompt: { kind: "local_confirmation", device: step.confirmation },
    });
    expect(Date.parse(shown.resume_summary.pending_approval.expires_at)).toBe(
      Date.parse(step.confirmation.deadline_at),
    );

    getMockProvider().setConversePlan(conversation.id, [{ text: "Erledigt." }]);
    const granted = await fetch(
      `${api}/v1/conversations/${conversation.id}/tool-calls/${step.tool_call_id}/respond`,
      { method: "POST", headers: desktop, body: JSON.stringify({ output: { confirmed: true } }) },
    );
    expect(granted.status).toBe(200);
    expect((await toolCall(step.tool_call_id)).confirmation_state).toBe("confirmed");
    expect(await auditFor("local_confirmation.granted", step.tool_call_id)).toHaveLength(1);
  });

  test("the owner declines, nothing runs and the command hears it once", async () => {
    const conversation = await seedConversation(server.db, {
      tenant_id: server.tenantId,
      owner_id,
    });
    const step = await askedStep(conversation.id);
    getMockProvider().setConversePlan(conversation.id, [{ text: "Gut, ich lasse es." }]);
    const port = recordingPort();
    await respondElicitationForTest(
      {
        tenant_id: server.tenantId,
        conversation_id: conversation.id,
        elicitation_id: step.elicitation_id,
        actor_id: owner_id,
        principal: browserPrincipal(owner_id, ["member"]),
        output: { confirmed: false },
        local_confirmations: port,
        now: new Date(getTestNow() + 60_000),
      },
      server.db,
    );
    expect((await toolCall(step.tool_call_id)).confirmation_state).toBe("declined");
    expect(port.seen.map((seen) => seen.state)).toEqual(["declined"]);
    expect(await auditFor("local_confirmation.declined", step.tool_call_id)).toHaveLength(1);
    expect(await auditFor("local_confirmation.granted", step.tool_call_id)).toHaveLength(0);
  });
});

async function runnerToken(device_runner_id: string, key: KeyObject): Promise<string> {
  const text = JSON.stringify({
    aud: RUNNER_ASSERTION_AUDIENCE,
    device_runner_id,
    iat: new Date(getTestNow()).toISOString(),
    nonce: Buffer.alloc(16, 7).toString("base64url"),
  });
  const response = await fetch(`${server.baseUrl}/v1/device-runner/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      assertion: text,
      signature: sign(null, Buffer.from(text), key).toString("base64url"),
    }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
