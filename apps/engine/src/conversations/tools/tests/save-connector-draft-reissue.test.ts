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
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
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
// Each test owns its own Bun.serve instance bound to a deterministic
// high-port slot in the IANA ephemeral range (49152-65535). Round-1
// used `port: 0` (OS-assigned) which flaked under parallel suite runs:
// the same freed port could be re-handed to a sibling test's server
// after this suite released it, and the in-flight `fetch` of `/broken`
// occasionally landed on the stranger's fixture (returning 200 instead
// of 500). Sequence-bind from a per-suite base + per-test offset keeps
// the bound port stable for the lifetime of the test, and the marker
// header below catches any residual collision before assertions run.
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

// Capture the real `fetch` at module load for the test-side health
// pre-flight below. Engine production egress (the probe of `/broken`)
// reads the driver-fetch seam and is immune to global-fetch stubs, but
// a sibling suite elsewhere in the shared `bun test` process (e.g. an
// sk CLI suite) may stub `globalThis.fetch` mid-flight — so the test's
// own loopback call must not read the global at call time either.
const ORIGINAL_FETCH = globalThis.fetch.bind(globalThis);

// Unique fixture marker — makes probe responses observably ours and
// catches cross-test port collisions if a sibling suite happens to
// bind the same high port.
const FIXTURE_MARKER = "save-connector-reissue-fixture-9k83aB";

// Sequence-retry port selector — picks from a high-port window that no
// `port: 0` allocator should reach in normal use. We avoid `Date.now()`
// (banned by the determinism gate) and `Math.random()` (banned), so the
// starting port is derived from a module-scope counter that increments
// per `startProbeServer` call. If a port is already bound (EADDRINUSE),
// step to the next one and retry, up to 64 attempts.
const PORT_BASE = 53_000;
const PORT_WINDOW = 4_096;
let portCounter = 0;

function startProbeServer(): { server: ReturnType<typeof Bun.serve>; baseUrl: string } {
  const handler = (req: Request): Response => {
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
  };
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 64; attempt++) {
    const port = PORT_BASE + ((portCounter + attempt) % PORT_WINDOW);
    try {
      const s = Bun.serve({ port, hostname: "127.0.0.1", fetch: handler });
      portCounter = (portCounter + attempt + 1) % PORT_WINDOW;
      return { server: s, baseUrl: `http://127.0.0.1:${s.port}` };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`failed to bind probe fixture in 64 attempts (last error: ${String(lastError)})`);
}

// Defensive pre-flight: confirm the test's server is the one bound at
// `baseUrl` before running the body. The sequence-retry binder above
// makes collisions vanishingly unlikely, but the marker check is cheap
// and gives a clear diagnostic if it ever happens.
async function assertOwnServer(baseUrl: string): Promise<void> {
  const res = await ORIGINAL_FETCH(`${baseUrl}/health`);
  if (res.headers.get("x-fixture-marker") !== FIXTURE_MARKER) {
    throw new Error(
      `probe fixture port collision: ${baseUrl} is not the server this test started ` +
        `(missing x-fixture-marker header). The sequence-retry port allocator should ` +
        `prevent this; if you see it, a sibling suite is binding the same high port.`,
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
  });

  test("re-issue after a base_url edit patches the persisted connector instead of reporting already_persisted", async () => {
    await assertOwnServer(baseUrl);
    const toolCtx = await createToolCtx();
    await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "Base URL Edit API",
      driver: "http",
      environment: "dev",
      base_url: baseUrl,
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
  });

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
  test("re-issue with force_save: true after a failed probe persists and surfaces a warning", async () => {
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
  });

  // Regression: conversation 730c568a. The LLM force-saved a credential
  // the probe had failed seconds earlier. Subsequent executions
  // 401-ed against that very credential. The cooldown guard now
  // refuses force_save while the failed probe is still fresh.
  test("force_save is refused inside the cooldown window after a fresh failed probe", async () => {
    await assertOwnServer(baseUrl);
    const toolCtx = await createToolCtx();
    await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "Force Cooldown",
      driver: "http",
      environment: "dev",
      base_url: baseUrl,
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
  });

  test("force_save is allowed once the failed probe is older than the cooldown", async () => {
    await assertOwnServer(baseUrl);
    const toolCtx = await createToolCtx();
    await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "Cooldown Expired",
      driver: "http",
      environment: "dev",
      base_url: baseUrl,
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
  });

  test("re-issue after a failed probe without force_save returns the probe_failed envelope", async () => {
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
  });
});
