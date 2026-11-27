import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import * as serviceModule from "../../connectors/service.ts";
import { tenants } from "../../db/schema/identity.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { MODEL_RELAYED_ANSWER } from "../answer-actor.ts";
import { localCommandFingerprint, readLocalCommand } from "../local-command.ts";
import { setLocalCommandConfirmDepsForTests } from "../local-command-confirm.ts";
import * as dispatchModule from "../persistence/auto-persist/dispatch.ts";
import { confirmLocalCommandIntent } from "../persistence/auto-persist/local-command-kind.ts";
import type { AutoPersistInput } from "../persistence/auto-persist/types.ts";
import { _resetDraftCredentialCacheForTests } from "../persistence/draft-credential-cache.ts";
import * as saveModule from "../persistence/save-connector.ts";
import { connectorFieldPatch } from "../persistence/save-connector.ts";
import type { ConnectorDraftDocument, DraftDocument } from "../types.ts";
import * as commonModule from "./ask-user/common.ts";
import { askUserConfirmTool } from "./ask-user/confirm.ts";
import { gateLocalCommandProbe } from "./local-command-gate.ts";
import { probeConnectorDraftTool } from "./probe-connector-draft.ts";
import { type Harness, makeHarness, STDIO_DRAFT } from "./tests/local-mcp-harness.ts";

let testDb: TestDb;
let tenant_id: string;

beforeAll(async () => {
  testDb = await createTestDb("local_mcp_confirm");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-local-mcp-confirm", display_name: "T" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

afterEach(() => {
  _resetDraftCredentialCacheForTests();
  setLocalCommandConfirmDepsForTests(null);
});

function harness(connector?: ConnectorDraftDocument): Harness {
  return makeHarness(testDb.db, tenant_id, connector);
}

const PRINCIPAL: ResolvedPrincipal = {
  provider: "test",
  kind: "user",
  id: "user-owner",
  tenant_id: "t",
  roles: ["owner"],
};

function commitEnv(
  h: Harness,
  answer: AutoPersistInput["answer_actor"],
  command_sha256: string,
): Parameters<typeof confirmLocalCommandIntent>[0] {
  const p: AutoPersistInput = {
    tenant_id,
    conversation_id: h.context.conversation_id,
    actor_id: null,
    principal: PRINCIPAL,
    answer_actor: answer,
    elicitation_output: { confirmed: true },
    elicitation: { id: "elicitation-1", tool_name: "ask_user_confirm", input: {} },
    db: testDb.db,
  };
  return {
    p,
    intent: {
      kind: "confirm_local_command",
      payload: { command_sha256, probe_args: {} },
      description: "allow",
    },
    ctx: h.context,
  };
}

function connectorRow(id: string, config: Record<string, unknown>) {
  return {
    id,
    tenant_id,
    driver: "mcp",
    display_name: "Docker MCP",
    auth_type: "none",
    base_url: null,
    dsn: null,
    config,
  } as unknown as Awaited<ReturnType<typeof serviceModule.getConnector>>;
}

function engineDeps(record: string[], allowed = true) {
  setLocalCommandConfirmDepsForTests({
    allowed: async () => allowed,
    confirm: async (_db, _tenant, connectorId, principal, expectedHash) => {
      record.push(`confirm:${connectorId}:${principal.id}:${expectedHash.slice(0, 8)}`);
      return {};
    },
  });
}

function savingAs(connectorId: string, order: string[]) {
  return spyOn(saveModule, "saveConnectorAtomic").mockImplementation(async (params) => {
    order.push("save");
    expect(params.localCommandConfirmation).toBe(true);
    const draft = params.ctx.getDraft();
    await params.ctx.setDraft({
      ...draft,
      connector: { ...draft.connector, saved_connector_id: connectorId },
    } as DraftDocument);
    return { ok: true, data: {} };
  });
}

const HUMAN = { kind: "human" as const, user_id: PRINCIPAL.id, via: "chat" as const };

describe("confirm_local_command — only a person's answer counts", () => {
  const spec = readLocalCommand(STDIO_DRAFT.config);
  const fingerprint = spec ? localCommandFingerprint(spec) : "";

  test("an answer relayed by the model confirms nothing and starts nothing", async () => {
    const calls: string[] = [];
    engineDeps(calls);
    const probe = spyOn(probeConnectorDraftTool, "execute");
    try {
      const h = harness(STDIO_DRAFT);
      const result = await confirmLocalCommandIntent(
        commitEnv(h, MODEL_RELAYED_ANSWER, fingerprint),
      );
      expect(result.ok).toBe(false);
      expect((result as { error_code?: string }).error_code).toBe("mcp_local_command_unconfirmed");
      expect(calls).toEqual([]);
      expect(probe).not.toHaveBeenCalled();
      expect(h.draft().connector?.saved_connector_id).toBeNull();
    } finally {
      probe.mockRestore();
    }
  });

  test("the model cannot author the confirm_local_command intent itself", () => {
    const parsed = askUserConfirmTool.inputSchema.safeParse({
      question: "Allow docker?",
      kind: "mcp_local_command",
      commit_intent: {
        kind: "confirm_local_command",
        payload: { command_sha256: fingerprint },
        description: "allow",
      },
    });
    expect(parsed.success).toBe(false);
  });

  test("a command changed after the question was shown is not confirmed", async () => {
    const calls: string[] = [];
    engineDeps(calls);
    const h = harness({
      ...STDIO_DRAFT,
      config: { mcp: { ...(STDIO_DRAFT.config?.mcp as Record<string, unknown>), args: ["rm"] } },
    });
    const result = await confirmLocalCommandIntent(commitEnv(h, HUMAN, fingerprint));
    expect((result as { error_code?: string }).error_code).toBe("mcp_local_command_changed");
    expect(calls).toEqual([]);
  });

  test("a person's yes saves, confirms the shown hash through the engine, then probes", async () => {
    const order: string[] = [];
    const freshen = spyOn(dispatchModule, "maybeAutoFreshenCheckpointsForSave").mockResolvedValue();
    const save = savingAs("conn-1", order);
    engineDeps(order);
    const row = spyOn(serviceModule, "getConnector").mockResolvedValue(
      connectorRow("conn-1", {
        mcp: {
          ...(STDIO_DRAFT.config?.mcp as Record<string, unknown>),
          confirmed_command_hash: fingerprint,
        },
      }),
    );
    const probe = spyOn(probeConnectorDraftTool, "execute").mockImplementation(async () => {
      order.push("probe");
      return { ok: true, data: {} };
    });
    try {
      const h = harness(STDIO_DRAFT);
      const result = await confirmLocalCommandIntent(commitEnv(h, HUMAN, fingerprint));
      expect(result.ok).toBe(true);
      expect(order).toEqual([
        "save",
        `confirm:conn-1:user-owner:${fingerprint.slice(0, 8)}`,
        "probe",
      ]);
    } finally {
      freshen.mockRestore();
      save.mockRestore();
      row.mockRestore();
      probe.mockRestore();
    }
  });

  test("a confirmation the engine did not record never loops back into a probe", async () => {
    const order: string[] = [];
    const freshen = spyOn(dispatchModule, "maybeAutoFreshenCheckpointsForSave").mockResolvedValue();
    const save = savingAs("conn-3", order);
    engineDeps(order);
    const row = spyOn(serviceModule, "getConnector").mockResolvedValue(
      connectorRow("conn-3", STDIO_DRAFT.config ?? {}),
    );
    const probe = spyOn(probeConnectorDraftTool, "execute");
    try {
      const result = await confirmLocalCommandIntent(
        commitEnv(harness(STDIO_DRAFT), HUMAN, fingerprint),
      );
      expect((result as { error_code?: string }).error_code).toBe("mcp_local_command_unconfirmed");
      expect(probe).not.toHaveBeenCalled();
    } finally {
      freshen.mockRestore();
      save.mockRestore();
      row.mockRestore();
      probe.mockRestore();
    }
  });

  test.each([
    ["missing permission", false, null],
    ["self confirmation", true, "self_confirmation"],
  ])("%s tells the user that an owner or admin must confirm", async (_label, allowed, code) => {
    const order: string[] = [];
    const freshen = spyOn(dispatchModule, "maybeAutoFreshenCheckpointsForSave").mockResolvedValue();
    const save = savingAs("conn-2", order);
    setLocalCommandConfirmDepsForTests({
      allowed: async () => allowed,
      confirm: async () => {
        throw Object.assign(new Error("you entered or changed this command"), { code });
      },
    });
    const probe = spyOn(probeConnectorDraftTool, "execute");
    try {
      const result = await confirmLocalCommandIntent(
        commitEnv(harness(STDIO_DRAFT), HUMAN, fingerprint),
      );
      expect(result.ok).toBe(false);
      expect((result as { message?: string }).message).toContain("owner or admin");
      expect((result as { next_best_actions?: string[] }).next_best_actions).toEqual([
        "cannot_help",
      ]);
      expect(probe).not.toHaveBeenCalled();
    } finally {
      freshen.mockRestore();
      save.mockRestore();
      probe.mockRestore();
    }
  });
});

describe("a changed env value counts as a new command", () => {
  const confirmedSpec = readLocalCommand(STDIO_DRAFT.config);
  const confirmedHash = confirmedSpec ? localCommandFingerprint(confirmedSpec) : "";
  const savedConfig = {
    mcp: {
      ...(STDIO_DRAFT.config?.mcp as Record<string, unknown>),
      env: { NODE_OPTIONS: "--max-old-space-size=512" },
    },
  };
  const savedSpec = readLocalCommand(savedConfig);
  const savedHash = savedSpec ? localCommandFingerprint(savedSpec) : "";
  const changedDraft: ConnectorDraftDocument = {
    ...STDIO_DRAFT,
    saved_connector_id: "conn-env",
    config: {
      mcp: { ...savedConfig.mcp, env: { NODE_OPTIONS: "--require=/tmp/evil.js" } },
    },
  };

  test("the probe gate asks again although only the value changed", async () => {
    expect(savedHash).not.toBe(confirmedHash);
    const row = spyOn(serviceModule, "getConnector").mockResolvedValue(
      connectorRow("conn-env", {
        mcp: { ...savedConfig.mcp, confirmed_command_hash: savedHash },
      }),
    );
    const pause = spyOn(commonModule, "pauseForUserInput").mockResolvedValue({
      ok: true,
      data: {},
    });
    try {
      const gate = await gateLocalCommandProbe(harness(changedDraft).context, changedDraft, {});
      expect(gate.kind).toBe("stop");
      expect(pause).toHaveBeenCalledTimes(1);
    } finally {
      row.mockRestore();
      pause.mockRestore();
    }
  });

  test("the unchanged saved command proceeds with the engine's confirmation", async () => {
    const draft: ConnectorDraftDocument = {
      ...STDIO_DRAFT,
      saved_connector_id: "conn-env",
      config: savedConfig,
    };
    const row = spyOn(serviceModule, "getConnector").mockResolvedValue(
      connectorRow("conn-env", {
        mcp: { ...savedConfig.mcp, confirmed_command_hash: savedHash },
      }),
    );
    try {
      const gate = await gateLocalCommandProbe(harness(draft).context, draft, {});
      expect(gate).toEqual({
        kind: "proceed",
        confirmation: { confirmed_command_hash: savedHash },
      });
    } finally {
      row.mockRestore();
    }
  });

  test("the field patch carries the new env value and drops the old confirmation", () => {
    const patch = connectorFieldPatch(
      changedDraft,
      connectorRow("conn-env", {
        mcp: { ...savedConfig.mcp, confirmed_command_hash: savedHash },
      }) as NonNullable<Awaited<ReturnType<typeof serviceModule.getConnector>>>,
    );
    const mcp = (patch.config?.mcp ?? {}) as Record<string, unknown>;
    expect(mcp.env).toEqual({ NODE_OPTIONS: "--require=/tmp/evil.js" });
    expect(mcp.confirmed_command_hash).toBeUndefined();
  });
});
