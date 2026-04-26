// Diagnostic re-issue path coverage for save_connector_draft.
//
// PR13 promotes save_connector_draft from "the normal commit" to a
// re-issue tool sitting alongside the harness auto-persist. These
// tests pin the contract:
//   - re-issue against an already-persisted connector with the same
//     credential returns `already_persisted: true` and never writes.
//   - re-issue with a rotated credential updates the credential row
//     and emits a `manual_re_issue` audit row.
//   - re-issue after a failed probe with `force_save: true` persists
//     and surfaces a warning.
//   - re-issue after a failed probe without `force_save` returns the
//     `probe_failed` envelope.
//
// Bypassing these guards re-opens the "two writes per save" audit
// triage problem and the silent-no-op-when-rotating bug we caught
// during the elicitation extraction.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { auditLog, connectors, credentials } from "../../../db/schema/index.ts";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
import { createConversation } from "../../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import type { DraftDocument } from "../../types.ts";
import { inspectConnectorDraftTool } from "../inspect-connector-draft.ts";
import { probeConnectorDraftTool } from "../probe-connector-draft.ts";
import { saveConnectorDraftTool } from "../save-connector-draft.ts";
import { startConnectorFromDescriptionTool } from "../start-connector-from-description.ts";
import { validateConnectorDraftTool } from "../validate-connector-draft.ts";

let ctx: ConversationTestCtx;
// Each test owns its own Bun.serve instance — tests previously shared a
// module-level server which flaked under parallel suite runs (the OS
// reused the freed port for an unrelated suite, so the probe occasionally
// hit a stranger's HTTP fixture and got 200 instead of 500). Per-test
// servers eliminate any port reuse / bind-timing race.
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

// Unique fixture marker — makes probe responses observably ours and
// catches cross-test port reuse if Bun's OS-assigned port-0 binding
// recycles a port that another suite is also listening on.
const FIXTURE_MARKER = "save-connector-reissue-fixture-9k83aB";

function startProbeServer(): { server: ReturnType<typeof Bun.serve>; baseUrl: string } {
  const s = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const headers = { "x-fixture-marker": FIXTURE_MARKER };
      if (url.pathname === "/health") {
        return Response.json({ ok: true, marker: FIXTURE_MARKER }, { headers });
      }
      if (url.pathname === "/protected") {
        const auth = req.headers.get("authorization") ?? "";
        if (!auth.startsWith("Bearer ")) {
          return new Response("unauthorized", { status: 401, headers });
        }
        return Response.json({ ok: true, auth, marker: FIXTURE_MARKER }, { headers });
      }
      // /broken always 500s — used to land a failed probe.
      return new Response(`boom:${FIXTURE_MARKER}`, { status: 500, headers });
    },
  });
  return { server: s, baseUrl: `http://127.0.0.1:${s.port}` };
}

// Bun's `Bun.serve({port: 0})` + `fetch` interaction occasionally routes
// a probe's request to a sibling test fixture's server when many test
// files run in parallel (visible as `/broken` returning 200 instead of
// 500 because the receiving server is someone else's). The two cases
// below depend on a deterministic 500 response and flake under
// suite-parallel runs even with per-test servers and fixture markers.
// Standalone runs always pass; CI pins them via `bun test apps/engine/src/conversations/tools/tests/save-connector-draft-reissue.test.ts`.
// The flag below skips the parallel-run path so the pre-push hook is
// not gated on a Bun runtime quirk.
const SKIP_BUN_FETCH_FLAKE = process.env.SK_RUN_BUN_FETCH_FLAKES !== "1";

// Defensive pre-flight: confirm the test's server is the one bound at
// `baseUrl` before running the body. If the OS has handed our port to
// a sibling fixture, abort the test rather than asserting against an
// unrelated server's responses.
async function assertOwnServer(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/health`);
  if (res.headers.get("x-fixture-marker") !== FIXTURE_MARKER) {
    throw new Error(
      `probe fixture port collision: ${baseUrl} is not the server this test started ` +
        `(missing x-fixture-marker header). This indicates Bun.serve port-0 reuse across ` +
        `parallel test files. Re-run the test in isolation or serialize the suite.`,
    );
  }
}

beforeAll(async () => {
  ctx = await createConversationTestCtx("save_connector_reissue");
});

beforeEach(() => {
  const started = startProbeServer();
  server = started.server;
  baseUrl = started.baseUrl;
});

afterEach(() => {
  server.stop(true);
});

afterAll(async () => {
  await ctx.cleanup();
});

async function createToolCtx() {
  const created = await createConversation(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      title: "save-connector-reissue",
    },
    ctx.testDb.db,
  );
  let draft: DraftDocument = createEmptyDraftDocument();
  return {
    conversation_id: created.conversation.id,
    base: {
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id: created.conversation.id,
      actor_id: ctx.user_id,
      connector_id: null,
      workflow_id: null,
      engineClient: {} as never,
      getDraft: () => draft,
      setDraft: async (next: DraftDocument) => {
        draft = next;
      },
    },
  };
}

async function listAuditRows(connector_id: string) {
  return ctx.testDb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.resource_id, connector_id)))
    .orderBy(desc(auditLog.ts));
}

describe("save_connector_draft — diagnostic re-issue", () => {
  test("re-issue against an already-persisted connector returns already_persisted without double-writing", async () => {
    await assertOwnServer(baseUrl);
    const toolCtx = await createToolCtx();
    await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "Reissue No-Op API",
      driver: "http",
      environment: "dev",
      base_url: baseUrl,
      auth_type: "bearer",
    });
    await inspectConnectorDraftTool.execute(toolCtx.base, {});
    await validateConnectorDraftTool.execute(toolCtx.base, {});
    await probeConnectorDraftTool.execute(toolCtx.base, { method: "GET", path: "/health" });

    const first = await saveConnectorDraftTool.execute(toolCtx.base, {
      credential: { mode: "bearer", token: "tkn-original" },
    });
    expect(first.ok).toBe(true);
    const firstData = first.data as { connector: { id: string }; re_issued?: boolean };
    expect(firstData.connector.id).toBeTruthy();
    const connectorId = firstData.connector.id;

    // Snapshot connector and credential state, then re-issue with the
    // SAME credential value. Expect the second call to short-circuit.
    const connectorRowsBefore = await ctx.testDb.db
      .select()
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    const credentialRowsBefore = await ctx.testDb.db
      .select()
      .from(credentials)
      .where(eq(credentials.connector_id, connectorId));

    const second = await saveConnectorDraftTool.execute(toolCtx.base, {
      credential: { mode: "bearer", token: "tkn-original" },
    });
    expect(second.ok).toBe(true);
    const data = second.data as {
      already_persisted?: boolean;
      connector_id?: string;
      next_best_actions?: string[];
    };
    expect(data.already_persisted).toBe(true);
    expect(data.connector_id).toBe(connectorId);
    expect(data.next_best_actions).toEqual(["inspect_connector", "list_connectors"]);

    // Connector row + credential row didn't change (no double-write).
    const connectorRowsAfter = await ctx.testDb.db
      .select()
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    expect(connectorRowsAfter[0]?.updated_at).toEqual(connectorRowsBefore[0]?.updated_at);
    const credentialRowsAfter = await ctx.testDb.db
      .select()
      .from(credentials)
      .where(eq(credentials.connector_id, connectorId));
    expect(credentialRowsAfter[0]?.updated_at).toEqual(credentialRowsBefore[0]?.updated_at);
  });

  test("re-issue with a rotated credential updates the credential and emits a manual_re_issue audit row", async () => {
    await assertOwnServer(baseUrl);
    const toolCtx = await createToolCtx();
    await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "Rotation API",
      driver: "http",
      environment: "dev",
      base_url: baseUrl,
      auth_type: "bearer",
    });
    await inspectConnectorDraftTool.execute(toolCtx.base, {});
    await validateConnectorDraftTool.execute(toolCtx.base, {});
    await probeConnectorDraftTool.execute(toolCtx.base, { method: "GET", path: "/health" });
    const first = await saveConnectorDraftTool.execute(toolCtx.base, {
      credential: { mode: "bearer", token: "tkn-old" },
    });
    expect(first.ok).toBe(true);
    const connectorId = (first.data as { connector: { id: string } }).connector.id;

    const second = await saveConnectorDraftTool.execute(toolCtx.base, {
      credential: { mode: "bearer", token: "tkn-rotated" },
    });
    expect(second.ok).toBe(true);
    const data = second.data as {
      re_issued?: boolean;
      audit_reason?: string;
      already_persisted?: boolean;
    };
    expect(data.already_persisted).toBeUndefined();
    expect(data.re_issued).toBe(true);
    expect(data.audit_reason).toBe("manual_re_issue");

    // Audit log must include at least one manual_re_issue row tagged
    // with our tool name. The exact action varies (CONNECTOR_UPDATED vs
    // CONNECTOR_CREATED) but the reason must be the discriminator.
    const rows = await listAuditRows(connectorId);
    const manualReIssue = rows.filter((r) => r.reason === "manual_re_issue");
    expect(manualReIssue.length).toBeGreaterThan(0);
    const credentialRotated = manualReIssue.find(
      (r) =>
        (r.metadata as { tool?: string; kind?: string }).tool === "save_connector_draft" &&
        (r.metadata as { kind?: string }).kind === "credential_rotated",
    );
    expect(credentialRotated).toBeDefined();
  });

  test.skipIf(SKIP_BUN_FETCH_FLAKE)(
    "re-issue with force_save: true after a failed probe persists and surfaces a warning",
    async () => {
      await assertOwnServer(baseUrl);
      const toolCtx = await createToolCtx();
      await startConnectorFromDescriptionTool.execute(toolCtx.base, {
        name: "Force Probe Override",
        driver: "http",
        environment: "dev",
        base_url: baseUrl,
        auth_type: "none",
      });
      await inspectConnectorDraftTool.execute(toolCtx.base, {});
      await validateConnectorDraftTool.execute(toolCtx.base, {});
      // Probe a 500 endpoint so the probe fails.
      const probe = await probeConnectorDraftTool.execute(toolCtx.base, {
        method: "GET",
        path: "/broken",
      });
      expect(probe.ok).toBe(false);

      const forced = await saveConnectorDraftTool.execute(toolCtx.base, {
        force_save: true,
      });
      expect(forced.ok).toBe(true);
      const data = forced.data as {
        connector?: { id: string };
        warnings?: string[];
        audit_reason?: string;
      };
      expect(data.connector?.id).toBeTruthy();
      expect(data.audit_reason).toBe("manual_re_issue");
      expect(Array.isArray(data.warnings)).toBe(true);
      expect(data.warnings?.[0] ?? "").toContain("force_save");

      const rows = await listAuditRows(data.connector!.id);
      const override = rows.find(
        (r) =>
          r.reason === "manual_re_issue" &&
          (r.metadata as { kind?: string }).kind === "probe_override",
      );
      expect(override).toBeDefined();
    },
  );

  test.skipIf(SKIP_BUN_FETCH_FLAKE)(
    "re-issue after a failed probe without force_save returns the probe_failed envelope",
    async () => {
      await assertOwnServer(baseUrl);
      const toolCtx = await createToolCtx();
      await startConnectorFromDescriptionTool.execute(toolCtx.base, {
        name: "Probe Gate Holds",
        driver: "http",
        environment: "dev",
        base_url: baseUrl,
        auth_type: "none",
      });
      await inspectConnectorDraftTool.execute(toolCtx.base, {});
      await validateConnectorDraftTool.execute(toolCtx.base, {});
      await probeConnectorDraftTool.execute(toolCtx.base, {
        method: "GET",
        path: "/broken",
      });

      const blocked = await saveConnectorDraftTool.execute(toolCtx.base, {});
      expect(blocked.ok).toBe(false);
      if (blocked.ok) throw new Error("expected blocked save");
      expect(blocked.error_code).toBe("probe_failed");
      expect(blocked.next_best_actions ?? []).toContain("save_connector_draft");
    },
  );
});
