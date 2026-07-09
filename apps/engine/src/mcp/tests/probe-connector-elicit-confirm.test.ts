// MCP confirm-gate resolution over the wire — ONE rule, every client shape:
// approval is PORTAL-ONLY.
//
// A `confirm_before_execution` tool (here `probe_connector` POST/prod) needs a
// HUMAN. The approval is opened UNGRANTED and only the portal grants it, so
// nothing the model emits — and nothing in-band — can release the call:
//
//   1. Every client may call `confirm_tool_call`, and for none of them does it
//      approve anything. It is a TRIGGER: it claims an approval a person already
//      granted, and answers `approval_not_granted` until they have. There is no
//      capability-based refusal, because there is nothing left to refuse.
//   2. The `needs_confirm` envelope carries `tool_call_id` (the trigger handle)
//      and `approval_url` (where the person grants, out of band).
//   3. In-band elicitation is NOT a grant channel. Even a client that advertises
//      `elicitation` gets no in-band prompt — the engine never issues one. It
//      lands on the same portal path as everyone else: claude.ai auto-declines
//      the prompt with no human seeing it, and production recorded 29/29 prompts
//      timing out, so an in-band answer is never a verified human decision.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { and, count, desc, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
import { grantApproval } from "../../tools/approval.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
let mock: MockServer;

beforeAll(async () => {
  process.env.SK_MCP_MODE = "authoring";
  // Give the engine a public origin so `requestApproval` can mint a real
  // `approval_url`. Without one the envelope honestly reports `null`, which is a
  // different assertion (see the last test).
  process.env.SUBKIT_PUBLIC_BASE_URL = "https://engine.example.test";
  suite = await startMcpTestSuite("probe-connector-elicit-confirm");
  mock = await createMockServer((_req, res) => {
    jsonResponse(res, 201, { id: "created" });
  });
});

afterAll(async () => {
  await mock.close();
  await suite.cleanup();
  delete process.env.SK_MCP_MODE;
  delete process.env.SUBKIT_PUBLIC_BASE_URL;
});

// Connect a client that advertises the `elicitation` capability. The engine is
// portal-only and never issues an in-band prompt, so this client's elicitation
// handler must never fire — `elicitCount` proves that (it stays 0). If it ever
// went positive, an in-band grant channel would have reopened.
async function connectElicitClient(): Promise<{ client: Client; elicitCount: { n: number } }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${suite.http.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${suite.http.apiKey}` } },
  });
  const client = new Client(
    { name: "subkit-mcp-elicit-tests", version: "0.0.0" },
    { capabilities: { elicitation: {} } },
  );
  const elicitCount = { n: 0 };
  client.setRequestHandler(ElicitRequestSchema, async () => {
    elicitCount.n += 1;
    throw new Error("engine must not issue an in-band prompt — approval is portal-only");
  });
  await client.connect(transport as unknown as Transport);
  return { client, elicitCount };
}

type ApprovalAction =
  | "approval.requested"
  | "approval.granted"
  | "approval.declined"
  | "approval.approved";

/** Count of `auditLog` rows for one approval-lifecycle action in this tenant. */
async function approvalCount(action: ApprovalAction): Promise<number> {
  const rows = await suite.http.db
    .select({ c: count() })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, suite.http.tenantId), eq(auditLog.action, action)));
  return rows[0]?.c ?? 0;
}

/** The most recent approval id this tenant recorded for `action`. */
async function latestApprovalId(action: ApprovalAction): Promise<string> {
  const rows = await suite.http.db
    .select({ id: auditLog.resource_id })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, suite.http.tenantId), eq(auditLog.action, action)))
    .orderBy(desc(auditLog.ts))
    .limit(1);
  const id = rows[0]?.id;
  expect(id).toBeTruthy();
  return id as string;
}

/** Stand in for the human at the approval portal: the one channel that grants. */
async function humanGrants(approvalId: string): Promise<void> {
  const granted = await grantApproval({
    db: suite.http.db,
    approval_id: approvalId,
    tenant_id: suite.http.tenantId,
    granted_by_user_id: suite.http.userId,
    via: "portal",
  });
  expect(granted.ok).toBe(true);
}

function textPayload(result: unknown): Record<string, unknown> {
  const content = (result as { content?: unknown }).content as Array<{ text: string }>;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

const probeArgs = (slug: string) => ({
  connector_slug: slug,
  method: "POST" as const,
  path: "/orders",
  environment: "prod" as const,
  body: { qty: 1 },
});

describe("probe_connector confirm gate — a human grants, the model triggers", () => {
  test("elicitation-capable client: no in-band prompt fires; the call is portal-only", async () => {
    await suite.seedConnector({
      slug: "elicit-portal-only",
      environment: "prod",
      base_url: mock.baseUrl,
    });

    const grantedBaseline = await approvalCount("approval.granted");
    const approvedBaseline = await approvalCount("approval.approved");

    const { client, elicitCount } = await connectElicitClient();
    try {
      // The responder is listed for every client, and callable by every client.
      const listed = await client.listTools();
      expect(listed.tools.some((t) => t.name === "confirm_tool_call")).toBe(true);

      // First call → needs_confirm envelope + the portal link. NOT executed, and
      // no in-band prompt was ever issued to this elicitation-capable client.
      const first = await client.callTool({
        name: "probe_connector",
        arguments: probeArgs("elicit-portal-only"),
      });
      expect(first.isError).toBeFalsy();
      const firstPayload = textPayload(first);
      expect(firstPayload.status).toBe("needs_confirm");
      expect(firstPayload.policy_mode).toBe("confirm_before_execution");
      expect(firstPayload.status_code).toBeUndefined();
      expect(elicitCount.n).toBe(0);
      const confirmId = firstPayload.tool_call_id as string;
      expect(confirmId).toBeTruthy();
      expect(String(firstPayload.approval_url)).toMatch(
        /^https?:\/\/[^/]+\/v1\/tool-approvals\/decide\?grant=skag_[A-Za-z0-9_-]+$/,
      );

      // A person grants it at the portal; confirm_tool_call then executes.
      await humanGrants(confirmId);
      const confirmed = await client.callTool({
        name: "confirm_tool_call",
        arguments: { tool: "probe_connector", confirm_id: confirmId },
      });
      expect(confirmed.isError).toBeFalsy();
      expect(textPayload(confirmed).status_code).toBe(201);
      // Still no in-band prompt across the whole loop.
      expect(elicitCount.n).toBe(0);
    } finally {
      await client.close();
    }

    // The portal grant is the same grant a click would write — one grant, one approve.
    expect(await approvalCount("approval.granted")).toBe(grantedBaseline + 1);
    expect(await approvalCount("approval.approved")).toBe(approvedBaseline + 1);
  });

  test("confirm_tool_call is open to an elicitation-capable client — and grants nothing", async () => {
    await suite.seedConnector({
      slug: "elicit-trigger-open",
      environment: "prod",
      base_url: mock.baseUrl,
    });

    // The call reaches the claim and loses there, which is the honest answer: the
    // approval it names was never granted by a person. Nothing is refused merely
    // for a capability the client happens to advertise — the claim is the gate.
    const { client, elicitCount } = await connectElicitClient();
    try {
      const first = await client.callTool({
        name: "probe_connector",
        arguments: probeArgs("elicit-trigger-open"),
      });
      const confirmId = textPayload(first).tool_call_id as string;
      expect(confirmId).toBeTruthy();
      expect(elicitCount.n).toBe(0);

      const triggered = await client.callTool({
        name: "confirm_tool_call",
        arguments: { tool: "probe_connector", confirm_id: confirmId },
      });
      expect(triggered.isError).toBe(true);
      const payload = textPayload(triggered);
      expect(payload.error_code).toBe("approval_not_granted");
      expect(payload.status_code).toBeUndefined();

      // A forged id is not special-cased either — it simply names no approval.
      const forged = await client.callTool({
        name: "confirm_tool_call",
        arguments: { tool: "probe_connector", confirm_id: "11111111-1111-1111-1111-111111111111" },
      });
      expect(forged.isError).toBe(true);
      expect(textPayload(forged).error_code).toBe("unknown_confirmation");
    } finally {
      await client.close();
    }
  });

  test("a _meta.sk_confirm marker is a trigger too — it cannot grant its own approval", async () => {
    await suite.seedConnector({
      slug: "elicit-marker-trigger",
      environment: "prod",
      base_url: mock.baseUrl,
    });

    // The transport marker was the "second door" the old capability refusal
    // guarded. It needs no guard: `dispatchTool` claims with it, and the claim
    // fails on an approval no person granted.
    const { client, elicitCount } = await connectElicitClient();
    try {
      const first = await client.callTool({
        name: "probe_connector",
        arguments: probeArgs("elicit-marker-trigger"),
      });
      const confirmId = textPayload(first).tool_call_id as string;
      expect(confirmId).toBeTruthy();

      const marked = await client.callTool({
        name: "probe_connector",
        arguments: probeArgs("elicit-marker-trigger"),
        _meta: { sk_confirm: true, sk_confirm_id: confirmId },
      });
      expect(marked.isError).toBe(true);
      const payload = textPayload(marked);
      expect(payload.error_code).toBe("approval_not_granted");
      expect(payload.status_code).toBeUndefined();
      // Portal-only: no in-band prompt ever fired on either call.
      expect(elicitCount.n).toBe(0);
    } finally {
      await client.close();
    }
  });

  test("elicitation-capable client: single-use portal loop, early trigger fires blank, no in-band prompt", async () => {
    await suite.seedConnector({
      slug: "elicit-unfulfilled",
      environment: "prod",
      base_url: mock.baseUrl,
    });

    const requestedBaseline = await approvalCount("approval.requested");
    const { client, elicitCount } = await connectElicitClient();
    try {
      const first = await client.callTool({
        name: "probe_connector",
        arguments: probeArgs("elicit-unfulfilled"),
      });
      // A pause, not a refusal: nothing ran, and the approval is still open.
      expect(first.isError).toBeFalsy();
      const firstPayload = textPayload(first);
      expect(firstPayload.status).toBe("needs_confirm");
      expect(firstPayload.error_code).toBeUndefined();
      expect(firstPayload.status_code).toBeUndefined();
      expect(firstPayload.policy_mode).toBe("confirm_before_execution");
      expect(elicitCount.n).toBe(0); // portal-only: no in-band prompt is issued

      const confirmId = firstPayload.tool_call_id as string;
      expect(confirmId).toBeTruthy();
      // The human affordance, named. This is what the model relays to a person.
      // Origin-agnostic: the host is environmental (a global-config singleton a
      // concurrent suite can transiently repoint). Assert the portal PATH + a
      // well-formed `skag_` grant token.
      expect(String(firstPayload.approval_url)).toMatch(
        /^https?:\/\/[^/]+\/v1\/tool-approvals\/decide\?grant=skag_[A-Za-z0-9_-]+$/,
      );
      expect(String(firstPayload.instruction)).toContain("Send this link to the person");
      // The prose must never claim nobody was asked — this client may be showing
      // its operator the prompt right now. It says only that IT did not answer.
      expect(String(firstPayload.instruction)).not.toContain("nobody has been asked");
      expect(await approvalCount("approval.requested")).toBe(requestedBaseline + 1);

      // Before the human decides, the trigger fires blank.
      const early = await client.callTool({
        name: "confirm_tool_call",
        arguments: { tool: "probe_connector", confirm_id: confirmId },
      });
      expect(early.isError).toBe(true);
      expect(textPayload(early).error_code).toBe("approval_not_granted");

      // A person opens the link and approves.
      await humanGrants(confirmId);

      const approvedBaseline = await approvalCount("approval.approved");
      const approved = await client.callTool({
        name: "confirm_tool_call",
        arguments: { tool: "probe_connector", confirm_id: confirmId },
      });
      expect(approved.isError).toBeFalsy();
      expect(textPayload(approved).status_code).toBe(201);
      expect(await approvalCount("approval.approved")).toBe(approvedBaseline + 1);
      // No in-band prompt fired across the whole loop.
      expect(elicitCount.n).toBe(0);

      // Single-use: the burned handle is refused.
      const replay = await client.callTool({
        name: "confirm_tool_call",
        arguments: { tool: "probe_connector", confirm_id: confirmId },
      });
      expect(replay.isError).toBe(true);
      expect(textPayload(replay).error_code).toBe("confirmation_already_used");
    } finally {
      await client.close();
    }
  });

  test("client without elicitation: needs_confirm carries the link; only a granted approval runs", async () => {
    await suite.seedConnector({
      slug: "fallback-confirm",
      environment: "prod",
      base_url: mock.baseUrl,
    });

    const client = await suite.connect();

    // Non-elicitation clients are offered the responder tool.
    const listed = await client.listTools();
    expect(listed.tools.some((t) => t.name === "confirm_tool_call")).toBe(true);

    const args = probeArgs("fallback-confirm");

    // First call → needs_confirm envelope carrying the trigger handle + the link.
    const first = await client.callTool({ name: "probe_connector", arguments: args });
    const firstPayload = textPayload(first);
    expect(firstPayload.policy_mode).toBe("confirm_before_execution");
    const confirmId = firstPayload.tool_call_id as string;
    expect(confirmId).toBeTruthy();
    // Origin-agnostic — see the note on the sibling assertion above.
    expect(String(firstPayload.approval_url)).toMatch(
      /^https?:\/\/[^/]+\/v1\/tool-approvals\/decide\?grant=skag_[A-Za-z0-9_-]+$/,
    );

    // The model cannot approve its own call, even holding a real id.
    const early = await client.callTool({
      name: "confirm_tool_call",
      arguments: { tool: "probe_connector", arguments: args, confirm_id: confirmId },
    });
    expect(early.isError).toBe(true);
    expect(textPayload(early).error_code).toBe("approval_not_granted");

    await humanGrants(confirmId);

    const approvedBaseline = await approvalCount("approval.approved");
    const approved = await client.callTool({
      name: "confirm_tool_call",
      arguments: { tool: "probe_connector", arguments: args, confirm_id: confirmId },
    });
    expect(approved.isError).toBeFalsy();
    expect(textPayload(approved).status_code).toBe(201);

    // APPROVAL_APPROVED correlates to the original tool_call_id.
    expect(await approvalCount("approval.approved")).toBe(approvedBaseline + 1);
    expect(await latestApprovalId("approval.approved")).toBe(confirmId);
  });
});

// Hardening: confirm_tool_call must reference a real, GRANTED, un-consumed
// approval — otherwise a model-driven client could trigger an arbitrary or
// recycled confirm_id (and write an APPROVAL_APPROVED that joins no request).
describe("confirm_tool_call — confirmation validation", () => {
  test("unknown/forged confirm_id → rejected, not executed, no APPROVAL_APPROVED", async () => {
    await suite.seedConnector({
      slug: "forged-confirm",
      environment: "prod",
      base_url: mock.baseUrl,
    });
    const client = await suite.connect();

    const approvedBaseline = await approvalCount("approval.approved");

    const res = await client.callTool({
      name: "confirm_tool_call",
      arguments: {
        tool: "probe_connector",
        arguments: probeArgs("forged-confirm"),
        confirm_id: "00000000-0000-0000-0000-000000000000",
      },
    });

    expect(res.isError).toBe(true);
    expect(textPayload(res).error_code).toBe("unknown_confirmation");
    expect(await approvalCount("approval.approved")).toBe(approvedBaseline);
  });

  test("re-using an already-approved confirm_id → rejected (single-use)", async () => {
    await suite.seedConnector({
      slug: "reuse-confirm",
      environment: "prod",
      base_url: mock.baseUrl,
    });
    const client = await suite.connect();
    const args = probeArgs("reuse-confirm");

    // Obtain a real pending confirmation, then have a person grant it.
    const first = await client.callTool({ name: "probe_connector", arguments: args });
    const id = textPayload(first).tool_call_id as string;
    expect(id).toBeTruthy();
    await humanGrants(id);

    // First trigger succeeds.
    const ok = await client.callTool({
      name: "confirm_tool_call",
      arguments: { tool: "probe_connector", arguments: args, confirm_id: id },
    });
    expect(ok.isError).toBeFalsy();

    // Re-using the same id is rejected — the approval was consumed.
    const again = await client.callTool({
      name: "confirm_tool_call",
      arguments: { tool: "probe_connector", arguments: args, confirm_id: id },
    });
    expect(again.isError).toBe(true);
    expect(textPayload(again).error_code).toBe("confirmation_already_used");
  });
});
