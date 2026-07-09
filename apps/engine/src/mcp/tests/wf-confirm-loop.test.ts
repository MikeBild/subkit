// The closed loop for a `wf_<slug>` tool: a workflow whose write steps are
// held in preview must mint a claimable-once-a-human-decides approval, and
// `confirm_tool_call` must actually release that write — but ONLY after a
// human grants it. It never approves anything itself.
//
// AN APPROVAL IS GRANTED BY A HUMAN, NEVER BY A MODEL (see the file header of
// tools/approval.ts). Production evidence: 29 `elicitation/create` timeouts,
// zero fulfilled prompts, ever. So `confirm_tool_call` is a TRIGGER — it
// claims a row a human already granted, out of band, at the approval's
// `approval_url`, and answers `approval_not_granted` until they have. This
// file proves the loop end to end: preview → approval row (ungranted) →
// confirm_tool_call BEFORE a human decides fails → a human grants it (the
// portal, stood in for by calling `grantApproval` directly, as the
// probe_connector precedent does) → confirm_tool_call now dispatches the held
// write → single-use → read-only workflows mint nothing to confirm — and that
// none of this changes for an elicitation-capable client, because
// confirm_tool_call is a trigger for every client shape, not a gate.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { and, desc, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import { auditLog, toolApprovals } from "../../db/schema/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
import { grantApproval } from "../../tools/approval.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
let mock: MockServer;
const hits: Array<{ method: string; url: string }> = [];

beforeAll(async () => {
  // Give the engine a public origin so `requestApproval` can mint a real
  // `approval_url` — the human's only channel to decide.
  process.env.SUBKIT_PUBLIC_BASE_URL = "https://engine.example.test";
  suite = await startMcpTestSuite("wf-confirm-loop");
  mock = await createMockServer((req, res) => {
    hits.push({ method: req.method ?? "", url: req.url ?? "" });
    if (req.url?.startsWith("/data")) {
      return jsonResponse(res, 200, { ok: true });
    }
    return jsonResponse(res, 200, { delivered: true });
  });
});

afterAll(async () => {
  await mock.close();
  await suite.cleanup();
  delete process.env.SUBKIT_PUBLIC_BASE_URL;
});

interface PreviewBody {
  preview?: boolean;
  writes_held?: boolean;
  would_write?: Array<{ step: string; method: string | null; url?: string | null }>;
  confirm_id?: string;
  approval_url?: string;
}

interface ConfirmErrorBody {
  error_code?: string;
  message?: string;
}

async function findAuditRow(action: string, resource_id: string) {
  const rows = await suite.http.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, suite.http.tenantId),
        eq(auditLog.action, action),
        eq(auditLog.resource_id, resource_id),
      ),
    )
    .orderBy(desc(auditLog.ts))
    .limit(1);
  return rows[0] ?? null;
}

async function findApprovalRow(confirm_id: string) {
  const rows = await suite.http.db
    .select()
    .from(toolApprovals)
    .where(and(eq(toolApprovals.tenant_id, suite.http.tenantId), eq(toolApprovals.id, confirm_id)))
    .limit(1);
  return rows[0] ?? null;
}

/** Stand in for the human at the approval portal — the one channel that
 *  grants. Mirrors `probe-connector-elicit-confirm.test.ts`'s `humanGrants`. */
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

describe("mcp wf_<slug> confirm-tool-call closed loop", () => {
  test("preview mints an ungranted approval; confirm_tool_call before a human decides fails; a human grants it; confirm_tool_call then performs the held write; single-use", async () => {
    hits.length = 0;
    await suite.seedWorkflow({
      name: "confirm loop probe",
      slug: "confirm-loop-probe",
      steps: [
        { kind: "request", id: "fetch", method: "GET", url: `${mock.baseUrl}/data` },
        {
          kind: "request",
          id: "send",
          method: "POST",
          url: `${mock.baseUrl}/send`,
          body: { ok: true },
        },
      ],
    });
    const client = await suite.connect();

    // 1. First touch: writes held. The envelope must carry preview,
    // writes_held, a non-empty would_write list, a confirm_id, AND the
    // approval_url a human opens to decide.
    const first = await client.callTool({ name: "wf_confirm-loop-probe", arguments: {} });
    expect(first.isError).toBeFalsy();
    const firstContent = first.content as Array<{ type: string; text: string }>;
    const firstBody = JSON.parse(firstContent[0]!.text) as PreviewBody;
    expect(firstBody.preview).toBe(true);
    expect(firstBody.writes_held).toBe(true);
    expect(firstBody.would_write?.length).toBeGreaterThan(0);
    expect(firstBody.would_write?.[0]?.step).toBe("send");
    expect(firstBody.would_write?.[0]?.method).toBe("POST");
    expect(typeof firstBody.confirm_id).toBe("string");
    const confirmId = firstBody.confirm_id as string;
    // Origin-agnostic: the public origin is environmental (and a global-config
    // singleton another concurrent suite can transiently repoint), so assert the
    // portal PATH + a well-formed `skag_` grant token, not a specific host.
    expect(String(firstBody.approval_url)).toMatch(
      /^https?:\/\/[^/]+\/v1\/tool-approvals\/decide\?grant=skag_[A-Za-z0-9_-]+$/,
    );

    // The read step ran for real; the held write must NOT have hit the wire.
    expect(hits.some((h) => h.url.startsWith("/data"))).toBe(true);
    expect(hits.some((h) => h.url.startsWith("/send"))).toBe(false);

    // 2. APPROVAL_REQUESTED audit row + an ungranted tool_approvals row.
    const requested = await findAuditRow(AuditAction.APPROVAL_REQUESTED, confirmId);
    expect(requested).not.toBeNull();
    expect((requested?.metadata as Record<string, unknown> | null)?.tool).toBe(
      "wf_confirm-loop-probe",
    );

    const approvalRow = await findApprovalRow(confirmId);
    expect(approvalRow).not.toBeNull();
    expect(approvalRow?.tool).toBe("wf_confirm-loop-probe");
    expect(approvalRow?.surface).toBe("mcp");
    expect(approvalRow?.granted_at).toBeNull();
    expect(approvalRow?.consumed_at).toBeNull();

    // 3. confirm_tool_call BEFORE a human decides is a trigger with nothing to
    // fire: the model cannot approve its own call. Nothing runs, nothing is
    // burned, and the handle is still intact for when a human does decide.
    const early = await client.callTool({
      name: "confirm_tool_call",
      arguments: { tool: "wf_confirm-loop-probe", confirm_id: confirmId },
    });
    expect(early.isError).toBe(true);
    const earlyBody = JSON.parse(
      (early.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as ConfirmErrorBody;
    expect(earlyBody.error_code).toBe("approval_not_granted");
    expect(hits.some((h) => h.url.startsWith("/send"))).toBe(false);
    const approvalRowAfterEarly = await findApprovalRow(confirmId);
    expect(approvalRowAfterEarly?.granted_at).toBeNull();
    expect(approvalRowAfterEarly?.consumed_at).toBeNull();

    // 4. A person opens the approval_url and grants it.
    await humanGrants(confirmId);

    // 5. confirm_tool_call carries NO domain arguments — only tool + confirm_id
    // — and the engine replays the args it already holds with writes released.
    const confirmed = await client.callTool({
      name: "confirm_tool_call",
      arguments: { tool: "wf_confirm-loop-probe", confirm_id: confirmId },
    });
    expect(confirmed.isError).toBeFalsy();

    // The write now actually dispatched.
    expect(hits.some((h) => h.url.startsWith("/send"))).toBe(true);

    // 6. APPROVAL_APPROVED joins APPROVAL_REQUESTED by resource_id (and
    // resource_type), and the approval row is now consumed.
    const approved = await findAuditRow(AuditAction.APPROVAL_APPROVED, confirmId);
    expect(approved).not.toBeNull();
    expect(approved?.resource_id).toBe(requested?.resource_id);
    expect(approved?.resource_type).toBe(requested?.resource_type);

    const approvalRowAfter = await findApprovalRow(confirmId);
    expect(approvalRowAfter?.granted_at).not.toBeNull();
    expect(approvalRowAfter?.consumed_at).not.toBeNull();

    // 7. A second confirm_tool_call with the SAME confirm_id fails: single use.
    const sendHitsBeforeSecondConfirm = hits.filter((h) => h.url.startsWith("/send")).length;
    const secondConfirm = await client.callTool({
      name: "confirm_tool_call",
      arguments: { tool: "wf_confirm-loop-probe", confirm_id: confirmId },
    });
    expect(secondConfirm.isError).toBe(true);
    const secondContent = secondConfirm.content as Array<{ type: string; text: string }>;
    const secondBody = JSON.parse(secondContent[0]!.text) as ConfirmErrorBody;
    expect(secondBody.error_code).toBe("confirmation_already_used");
    // Rejected before dispatch — no additional write hit the wire.
    expect(hits.filter((h) => h.url.startsWith("/send")).length).toBe(sendHitsBeforeSecondConfirm);
  });

  test("a read-only workflow mints no approval and returns no confirm_id or approval_url", async () => {
    await suite.seedWorkflow({
      name: "read only probe",
      slug: "read-only-probe",
      steps: [{ kind: "request", id: "fetch", method: "GET", url: `${mock.baseUrl}/data` }],
    });
    const client = await suite.connect();

    const result = await client.callTool({ name: "wf_read-only-probe", arguments: {} });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0]!.text) as PreviewBody;
    expect(body.preview).toBeUndefined();
    expect(body.confirm_id).toBeUndefined();
    expect(body.approval_url).toBeUndefined();
    const meta = (result as { _meta?: { subkit?: { confirm?: unknown } } })._meta;
    expect(meta?.subkit?.confirm).toBeUndefined();

    // No APPROVAL_REQUESTED row was minted for this tool — a read-only
    // workflow has nothing to hold, so nothing to confirm.
    const rows = await suite.http.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, suite.http.tenantId),
          eq(auditLog.action, AuditAction.APPROVAL_REQUESTED),
        ),
      );
    const forThisTool = rows.filter(
      (r) => (r.metadata as Record<string, unknown> | null)?.tool === "wf_read-only-probe",
    );
    expect(forThisTool).toHaveLength(0);
  });

  // Hardening: approval over MCP is portal-only for every client shape. An
  // elicitation-capable client gets no in-band prompt — the engine never issues
  // one — and its held write still resolves through the portal + confirm_tool_call
  // trigger, exactly like a non-elicitation client.
  test("an elicitation-capable client still goes through the portal for a wf_<slug> write — no in-band prompt fires", async () => {
    await suite.seedWorkflow({
      name: "confirm loop elicit probe",
      slug: "confirm-loop-elicit-probe",
      steps: [
        { kind: "request", id: "fetch", method: "GET", url: `${mock.baseUrl}/data` },
        {
          kind: "request",
          id: "send",
          method: "POST",
          url: `${mock.baseUrl}/send-elicit-probe`,
          body: { ok: true },
        },
      ],
    });

    const transport = new StreamableHTTPClientTransport(new URL(`${suite.http.baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${suite.http.apiKey}` } },
    });
    const client = new Client(
      { name: "subkit-mcp-wf-elicit-tests", version: "0.0.0" },
      { capabilities: { elicitation: {} } },
    );
    let elicitCount = 0;
    // Advertises the capability, but the engine never issues an in-band prompt:
    // approval is portal-only, so this handler must never fire.
    client.setRequestHandler(ElicitRequestSchema, async () => {
      elicitCount += 1;
      throw new Error("client cannot fulfil elicitation");
    });
    await client.connect(transport as unknown as Transport);

    try {
      const first = await client.callTool({
        name: "wf_confirm-loop-elicit-probe",
        arguments: {},
      });
      expect(first.isError).toBeFalsy();
      const firstBody = JSON.parse(
        (first.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as PreviewBody;
      const confirmId = firstBody.confirm_id as string;
      expect(confirmId).toBeTruthy();
      expect(elicitCount).toBe(0); // no in-band prompt is ever attempted

      // The trigger fires blank — the approval was never granted by anyone.
      const triggered = await client.callTool({
        name: "confirm_tool_call",
        arguments: { tool: "wf_confirm-loop-elicit-probe", confirm_id: confirmId },
      });
      expect(triggered.isError).toBe(true);
      const triggeredBody = JSON.parse(
        (triggered.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as ConfirmErrorBody;
      expect(triggeredBody.error_code).toBe("approval_not_granted");
      expect(hits.some((h) => h.url.startsWith("/send-elicit-probe"))).toBe(false);

      // Only once a human grants it (out of band) does the trigger fire.
      await humanGrants(confirmId);
      const approved = await client.callTool({
        name: "confirm_tool_call",
        arguments: { tool: "wf_confirm-loop-elicit-probe", confirm_id: confirmId },
      });
      expect(approved.isError).toBeFalsy();
      expect(hits.some((h) => h.url.startsWith("/send-elicit-probe"))).toBe(true);
    } finally {
      await client.close();
    }
  });
});
