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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";

import { auditLog, connectors, credentials } from "../../../db/schema/index.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { withDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { createEmptyDraftDocument, withConnectorProbe } from "../../authoring-state.ts";
import { setDraftCredential } from "../../persistence/draft-credential-cache.ts";
import { createConversation } from "../../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import type { DraftDocument } from "../../types.ts";
import { inspectConnectorDraftTool } from "../inspect-connector-draft.ts";
import { probeConnectorDraftTool } from "../probe-connector-draft.ts";
import { saveConnectorDraftTool } from "../save-connector-draft.ts";
import { startConnectorFromDescriptionTool } from "../start-connector-from-description.ts";
import { updateConnectorDraftTool } from "../update-connector-draft.ts";
import { validateConnectorDraftTool } from "../validate-connector-draft.ts";

let ctx: ConversationTestCtx;
const FIXTURE_MARKER = "save-connector-reissue-fixture-9k83aB";

// Keep discovery and probe traffic in the async-context-scoped driver seam.
// A real Bun.serve fixture made this otherwise-pure contract test depend on
// loopback socket lifetime while the discovery fallback launched Playwright;
// under the full suite the first probe could observe ECONNREFUSED even after
// its pre-flight succeeded. The in-memory transport preserves the exact HTTP
// response contract without sharing ports, global fetch, or browser state.
const fixtureFetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl);
    const headers = { "x-fixture-marker": FIXTURE_MARKER };
    if (url.pathname === "/") {
      return Response.json({
        openapi: "3.0.0",
        info: { title: "Reissue Fixture", version: "1.0.0" },
        paths: {
          "/health": { get: { responses: { "200": { description: "healthy" } } } },
          "/protected": { get: { responses: { "200": { description: "authorized" } } } },
          "/broken": { get: { responses: { "500": { description: "broken" } } } },
        },
      });
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true, marker: FIXTURE_MARKER }, { headers });
    }
    if (url.pathname === "/protected") {
      const requestHeaders = new Headers(init?.headers);
      const auth = requestHeaders.get("authorization") ?? "";
      if (!auth.startsWith("Bearer ")) {
        return new Response("unauthorized", { status: 401, headers });
      }
      return Response.json({ ok: true, auth, marker: FIXTURE_MARKER }, { headers });
    }
    return new Response(`boom:${FIXTURE_MARKER}`, { status: 500, headers });
  },
  { preconnect: () => {} },
) as typeof fetch;

function fixtureTest(name: string, body: () => Promise<void>): void {
  test(name, () => withDriverFetchForTests(fixtureFetch, body));
}

beforeAll(async () => {
  ctx = await createConversationTestCtx("save_connector_reissue");
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
    base_url: `https://${created.conversation.id}.save-connector-reissue.invalid`,
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
  fixtureTest(
    "re-issue against an already-persisted connector returns already_persisted without double-writing",
    async () => {
      const toolCtx = await createToolCtx();
      await startConnectorFromDescriptionTool.execute(toolCtx.base, {
        name: "Reissue No-Op API",
        driver: "http",
        environment: "dev",
        base_url: toolCtx.base_url,
        auth_type: "bearer",
      });
      await inspectConnectorDraftTool.execute(toolCtx.base, {});
      await validateConnectorDraftTool.execute(toolCtx.base, {});
      // The post-fix probe path refuses to go out unauthenticated for an
      // auth-required draft (see probe-connector-draft.ts credential
      // guard). Populate the cache directly to mirror the real flow
      // where `ask_user_form` would have cached the credential before
      // the LLM invokes probe.
      setDraftCredential(toolCtx.conversation_id, { mode: "bearer", token: "tkn-original" });
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
    },
  );

  fixtureTest(
    "re-issue after a base_url edit patches the persisted connector instead of reporting already_persisted",
    async () => {
      const toolCtx = await createToolCtx();
      await startConnectorFromDescriptionTool.execute(toolCtx.base, {
        name: "Base URL Edit API",
        driver: "http",
        environment: "dev",
        base_url: toolCtx.base_url,
        auth_type: "bearer",
      });
      await inspectConnectorDraftTool.execute(toolCtx.base, {});
      await validateConnectorDraftTool.execute(toolCtx.base, {});
      setDraftCredential(toolCtx.conversation_id, { mode: "bearer", token: "tkn-edit" });
      await probeConnectorDraftTool.execute(toolCtx.base, { method: "GET", path: "/health" });
      const first = await saveConnectorDraftTool.execute(toolCtx.base, {
        credential: { mode: "bearer", token: "tkn-edit" },
      });
      expect(first.ok).toBe(true);
      const connectorId = (first.data as { connector: { id: string } }).connector.id;

      // Operator corrects the base_url after the first save — exactly the
      // AppSync `/graphql` scenario. The re-issue path must patch the
      // persisted row, not short-circuit on the matching credential.
      const editedUrl = "http://127.0.0.1:59999/edited";
      const upd = await updateConnectorDraftTool.execute(toolCtx.base, { base_url: editedUrl });
      expect(upd.ok).toBe(true);

      const second = await saveConnectorDraftTool.execute(toolCtx.base, {
        credential: { mode: "bearer", token: "tkn-edit" },
      });
      expect(second.ok).toBe(true);
      const data = second.data as {
        already_persisted?: boolean;
        re_issued?: boolean;
        fields_updated?: string[];
      };
      // NOT a no-op: the base_url change is recognised and persisted.
      expect(data.already_persisted).toBeUndefined();
      expect(data.re_issued).toBe(true);
      expect(data.fields_updated).toEqual(["base_url"]);

      // The persisted connector row carries the corrected base_url.
      const rows = await ctx.testDb.db
        .select()
        .from(connectors)
        .where(eq(connectors.id, connectorId));
      expect(rows[0]?.base_url).toBe(editedUrl);

      // And the field edit is auditable as a connector.updated row.
      const audit = await listAuditRows(connectorId);
      expect(audit.some((r) => r.action === "connector.updated")).toBe(true);
    },
  );

  fixtureTest(
    "re-issue with a rotated credential updates the credential and emits a manual_re_issue audit row",
    async () => {
      const toolCtx = await createToolCtx();
      await startConnectorFromDescriptionTool.execute(toolCtx.base, {
        name: "Rotation API",
        driver: "http",
        environment: "dev",
        base_url: toolCtx.base_url,
        auth_type: "bearer",
      });
      await inspectConnectorDraftTool.execute(toolCtx.base, {});
      await validateConnectorDraftTool.execute(toolCtx.base, {});
      setDraftCredential(toolCtx.conversation_id, { mode: "bearer", token: "tkn-old" });
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
    },
  );

  // The two probe-failure cases below previously called the live probe
  // tool against a Bun.serve fixture's /broken endpoint, expecting a
  // deterministic 500. Under the full-suite run that fetch flaked: the
  // audit log showed `url_host:127.0.0.1:<our-port>` returning HTTP 200
  // even though our handler returns 500 — a Bun fetch / port-reuse
  // interaction we could not reliably contain via marker checks or
  // sequence-retry port allocation. The save_connector_draft contract
  // these tests pin reads from `draft.connector.latest_probe.ok` (see
  // saveConnectorAtomic — the probe gate is a pure draft-state check).
  // We inject a failed probe state directly via `withConnectorProbe`,
  // which is exactly what `probe_connector_draft` does on a 500 — but
  // without the network round-trip that flaked.
  fixtureTest(
    "re-issue with force_save: true after a failed probe persists and surfaces a warning",
    async () => {
      const toolCtx = await createToolCtx();
      await startConnectorFromDescriptionTool.execute(toolCtx.base, {
        name: "Force Probe Override",
        driver: "http",
        environment: "dev",
        base_url: toolCtx.base_url,
        auth_type: "none",
      });
      await inspectConnectorDraftTool.execute(toolCtx.base, {});
      await validateConnectorDraftTool.execute(toolCtx.base, {});
      // Inject a failed probe directly — equivalent to what
      // probe_connector_draft writes into the draft on a 500.
      const draftBefore = toolCtx.base.getDraft();
      const connectorBefore = draftBefore.connector;
      if (!connectorBefore) throw new Error("connector draft missing");
      const failedProbeDraft = withConnectorProbe(
        draftBefore,
        {
          ...connectorBefore,
          latest_probe: {
            ok: false,
            method: "GET",
            path: "/broken",
            environment: "dev",
            status_code: 500,
            duration_ms: 1,
            summary: "Probe reached the system but returned HTTP 500.",
            response_preview: "boom",
            // Probe ran 2 minutes ago — outside the 60s cooldown
            // window, so force_save is allowed. The cooldown gate
            // (Pass D4) rejects fresh failed probes; this test
            // covers the stale-probe override path.
            probed_at: new Date(getTestNow() - 120_000).toISOString(),
          },
        },
        false,
        "probe failed: HTTP 500",
        "connector_probe_failed",
      );
      await toolCtx.base.setDraft(failedProbeDraft);
      expect(toolCtx.base.getDraft().connector?.latest_probe?.ok).toBe(false);

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

  // Regression: conversation 730c568a. The LLM force-saved a credential
  // the probe had failed seconds earlier. Subsequent executions
  // 401-ed against that very credential. The cooldown guard now
  // refuses force_save while the failed probe is still fresh.
  fixtureTest(
    "force_save is refused inside the cooldown window after a fresh failed probe",
    async () => {
      const toolCtx = await createToolCtx();
      await startConnectorFromDescriptionTool.execute(toolCtx.base, {
        name: "Force Cooldown",
        driver: "http",
        environment: "dev",
        base_url: toolCtx.base_url,
        auth_type: "none",
      });
      await inspectConnectorDraftTool.execute(toolCtx.base, {});
      await validateConnectorDraftTool.execute(toolCtx.base, {});
      const draftBefore = toolCtx.base.getDraft();
      const connectorBefore = draftBefore.connector;
      if (!connectorBefore) throw new Error("connector draft missing");
      // Probe just failed — `probed_at = now` so the cooldown is in effect.
      const failedProbeDraft = withConnectorProbe(
        draftBefore,
        {
          ...connectorBefore,
          latest_probe: {
            ok: false,
            method: "GET",
            path: "/broken",
            environment: "dev",
            status_code: 401,
            duration_ms: 1,
            summary: "Probe reached the system but returned HTTP 401.",
            response_preview: "bad credentials",
            probed_at: new Date(getTestNow()).toISOString(),
          },
        },
        false,
        "probe failed: HTTP 401",
        "connector_probe_failed",
      );
      await toolCtx.base.setDraft(failedProbeDraft);

      const blocked = await saveConnectorDraftTool.execute(toolCtx.base, {
        force_save: true,
      });
      expect(blocked.ok).toBe(false);
      if (blocked.ok) throw new Error("expected cooldown rejection");
      expect(blocked.error_code).toBe("force_save_cooldown");
      expect(blocked.message ?? "").toMatch(/cooldown/);
    },
  );

  fixtureTest(
    "force_save is allowed once the failed probe is older than the cooldown",
    async () => {
      const toolCtx = await createToolCtx();
      await startConnectorFromDescriptionTool.execute(toolCtx.base, {
        name: "Cooldown Expired",
        driver: "http",
        environment: "dev",
        base_url: toolCtx.base_url,
        auth_type: "none",
      });
      await inspectConnectorDraftTool.execute(toolCtx.base, {});
      await validateConnectorDraftTool.execute(toolCtx.base, {});
      const draftBefore = toolCtx.base.getDraft();
      const connectorBefore = draftBefore.connector;
      if (!connectorBefore) throw new Error("connector draft missing");
      // Probe failed two minutes ago — outside the 60s cooldown.
      const olderThanCooldown = new Date(getTestNow() - 120_000).toISOString();
      const failedProbeDraft = withConnectorProbe(
        draftBefore,
        {
          ...connectorBefore,
          latest_probe: {
            ok: false,
            method: "GET",
            path: "/broken",
            environment: "dev",
            status_code: 500,
            duration_ms: 1,
            summary: "Probe reached the system but returned HTTP 500.",
            response_preview: "boom",
            probed_at: olderThanCooldown,
          },
        },
        false,
        "probe failed: HTTP 500",
        "connector_probe_failed",
      );
      await toolCtx.base.setDraft(failedProbeDraft);

      const allowed = await saveConnectorDraftTool.execute(toolCtx.base, {
        force_save: true,
      });
      expect(allowed.ok).toBe(true);
    },
  );

  fixtureTest(
    "re-issue after a failed probe without force_save returns the probe_failed envelope",
    async () => {
      const toolCtx = await createToolCtx();
      await startConnectorFromDescriptionTool.execute(toolCtx.base, {
        name: "Probe Gate Holds",
        driver: "http",
        environment: "dev",
        base_url: toolCtx.base_url,
        auth_type: "none",
      });
      await inspectConnectorDraftTool.execute(toolCtx.base, {});
      await validateConnectorDraftTool.execute(toolCtx.base, {});
      // Inject a failed probe directly (see comment above on why we no
      // longer route this through the live probe tool + Bun.serve).
      const draftBefore = toolCtx.base.getDraft();
      const connectorBefore = draftBefore.connector;
      if (!connectorBefore) throw new Error("connector draft missing");
      const failedProbeDraft = withConnectorProbe(
        draftBefore,
        {
          ...connectorBefore,
          latest_probe: {
            ok: false,
            method: "GET",
            path: "/broken",
            environment: "dev",
            status_code: 500,
            duration_ms: 1,
            summary: "Probe reached the system but returned HTTP 500.",
            response_preview: "boom",
          },
        },
        false,
        "probe failed: HTTP 500",
        "connector_probe_failed",
      );
      await toolCtx.base.setDraft(failedProbeDraft);

      const blocked = await saveConnectorDraftTool.execute(toolCtx.base, {});
      expect(blocked.ok).toBe(false);
      if (blocked.ok) throw new Error("expected blocked save");
      expect(blocked.error_code).toBe("probe_failed");
      expect(blocked.next_best_actions ?? []).toContain("save_connector_draft");
    },
  );
});
