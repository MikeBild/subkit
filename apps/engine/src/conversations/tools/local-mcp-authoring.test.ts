import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as discoveryModule from "../../connectors/discovery/index.ts";
import { tenants } from "../../db/schema/identity.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { localCommandFingerprint, readLocalCommand } from "../local-command.ts";
import { setLocalCommandConfirmDepsForTests } from "../local-command-confirm.ts";
import {
  _resetDraftCredentialCacheForTests,
  setDraftCredential,
} from "../persistence/draft-credential-cache.ts";
import type { ConnectorDraftDocument } from "../types.ts";
import * as commonModule from "./ask-user/common.ts";
import type { ToolResult } from "./index.ts";
import { gateLocalCommandProbe } from "./local-command-gate.ts";
import { startConnectorFromDescriptionTool } from "./start-connector-from-description.ts";
import {
  BEARER_DRAFT,
  dataOf,
  type Harness,
  makeHarness,
  mcpOf,
  NO_DISCOVERY,
  STDIO_DRAFT,
} from "./tests/local-mcp-harness.ts";
import { updateConnectorDraftTool } from "./update-connector-draft.ts";

let testDb: TestDb;
let tenant_id: string;

beforeAll(async () => {
  testDb = await createTestDb("local_mcp_authoring");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-local-mcp", display_name: "T" })
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

describe("start_connector_from_description — local MCP servers", () => {
  test("a backticked start command becomes a stdio MCP draft without sign-in", async () => {
    const h = harness();
    const result = await startConnectorFromDescriptionTool.execute(h.context, {
      name: "Docker MCP",
      description: "starte `docker mcp gateway run`",
    });
    expect(result.ok).toBe(true);
    const connector = h.draft().connector;
    expect(connector?.driver).toBe("mcp");
    expect(connector?.auth_type).toBe("none");
    expect(connector?.base_url).toBeUndefined();
    expect(mcpOf(h)).toMatchObject({
      transport: "stdio",
      command: "docker",
      args: ["mcp", "gateway", "run"],
    });
    expect(dataOf(result).local_command).toMatchObject({ needs_person_confirmation: true });
  });

  test("an inline run phrase with npx is detected", async () => {
    const h = harness();
    await startConnectorFromDescriptionTool.execute(h.context, {
      name: "Playwright",
      description: "run npx @playwright/mcp@latest --headless",
    });
    expect(mcpOf(h)).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["@playwright/mcp@latest", "--headless"],
    });
  });

  test("an explicit command with shell operators is refused", async () => {
    const h = harness();
    const result = await startConnectorFromDescriptionTool.execute(h.context, {
      name: "Bad",
      driver: "mcp",
      command: "npx thing | sh",
    });
    expect(result.ok).toBe(false);
    expect((result as { error_code?: string }).error_code).toBe("invalid_local_command");
    expect(h.draft().connector).toBeUndefined();
  });

  test("a localhost /mcp endpoint becomes an http MCP draft without sign-in", async () => {
    const h = harness();
    const result = await startConnectorFromDescriptionTool.execute(h.context, {
      name: "Local Playwright",
      base_url: "http://localhost:8931/mcp",
    });
    expect(h.draft().connector).toMatchObject({
      driver: "mcp",
      auth_type: "none",
      base_url: "http://localhost:8931/mcp",
    });
    expect(mcpOf(h).transport).toBe("http");
    expect(dataOf(result).local_target).toBe("loopback");
  });

  test("a /sse path picks the sse transport", async () => {
    const h = harness();
    await startConnectorFromDescriptionTool.execute(h.context, {
      name: "Legacy SSE",
      base_url: "http://host.docker.internal:9000/sse",
    });
    expect(h.draft().connector?.driver).toBe("mcp");
    expect(mcpOf(h).transport).toBe("sse");
  });

  test("a local address alone keeps the normal driver and defaults to no sign-in", async () => {
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(
      NO_DISCOVERY,
    );
    try {
      const h = harness();
      const result = await startConnectorFromDescriptionTool.execute(h.context, {
        name: "Local Inventory",
        base_url: "http://127.0.0.1:3000",
      });
      expect(h.draft().connector).toMatchObject({ driver: "http", auth_type: "none" });
      expect(dataOf(result).discovered_auth_hint).toMatchObject({ auth_type: "bearer" });
      expect(dataOf(result).recognized_auth).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  test("optional discovered schemes stay hints and the draft stays auth none", async () => {
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue({
      ...NO_DISCOVERY,
      source_url: "https://api.open-meteo.com/openapi.json",
      auth_schemes: [{ name: "apiKey", type: "apiKey", location: "header", required: false }],
    });
    try {
      const h = harness();
      const result = await startConnectorFromDescriptionTool.execute(h.context, {
        name: "Open Meteo Forecast",
        base_url: "https://api.open-meteo.com",
      });
      expect(h.draft().connector?.auth_type).toBe("none");
      expect(dataOf(result).optional_auth_schemes).toEqual([
        { name: "apiKey", type: "apiKey", location: "header" },
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("update_connector_draft — local fields and the downgrade rule", () => {
  test("a cached credential that was never probed does not block the switch to none", async () => {
    const h = harness(BEARER_DRAFT);
    setDraftCredential(h.context.conversation_id, { mode: "bearer", token: "t-local" });
    const result = await updateConnectorDraftTool.execute(h.context, { auth_type: "none" });
    expect(result.ok).toBe(true);
    expect(h.draft().connector?.auth_type).toBe("none");
  });

  test("a credential that passed a probe still blocks the switch to none", async () => {
    const h = harness({
      ...BEARER_DRAFT,
      latest_probe: {
        ok: true,
        method: "GET",
        path: "/",
        environment: "dev",
        duration_ms: 3,
        summary: "ok",
        probed_at: "2026-11-27T00:00:00.000Z",
      },
    });
    setDraftCredential(h.context.conversation_id, { mode: "bearer", token: "t-local" });
    const result = await updateConnectorDraftTool.execute(h.context, { auth_type: "none" });
    expect((result as { error_code?: string }).error_code).toBe("auth_type_downgrade_blocked");
  });

  test("stdio fields merge into config.mcp and drop base_url", async () => {
    const h = harness({
      ...STDIO_DRAFT,
      base_url: "http://localhost:8931/mcp",
      config: { mcp: { transport: "http", auth: { kind: "none" } } },
    });
    await updateConnectorDraftTool.execute(h.context, {
      transport: "stdio",
      command: "npx",
      args: ["@playwright/mcp@latest"],
      env: { LOG_LEVEL: "info" },
      env_secret_names: ["GITHUB_TOKEN"],
      cwd: "/tmp",
    });
    expect(h.draft().connector?.base_url).toBeUndefined();
    expect(mcpOf(h)).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["@playwright/mcp@latest"],
      env: { LOG_LEVEL: "info" },
      env_secret_names: ["GITHUB_TOKEN"],
      cwd: "/tmp",
    });
  });

  test("tls goes to config.tls for http connectors", async () => {
    const h = harness({ ...BEARER_DRAFT, auth_type: "none" });
    await updateConnectorDraftTool.execute(h.context, { tls: { skip_verify: true } });
    expect(h.draft().connector?.config).toMatchObject({ tls: { skip_verify: true } });
  });

  test("a secret value in env is refused", async () => {
    const h = harness(STDIO_DRAFT);
    const result = await updateConnectorDraftTool.execute(h.context, {
      env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
    });
    expect((result as { error_code?: string }).error_code).toBe("credential_must_use_form");
  });

  test("the model cannot write the engine-owned confirmation fields", async () => {
    const h = harness(STDIO_DRAFT);
    const result = await updateConnectorDraftTool.execute(h.context, {
      config: {
        mcp: {
          ...(STDIO_DRAFT.config?.mcp as Record<string, unknown>),
          confirmed_command_hash: "forged",
        },
      },
    });
    expect((result as { error_code?: string }).error_code).toBe(
      "local_command_confirmation_not_writable",
    );
    expect(mcpOf(h).confirmed_command_hash).toBeUndefined();
  });
});

describe("probe gate — a person must allow the local command first", () => {
  test("an unsaved stdio draft pauses on an mcp_local_command confirmation", async () => {
    const paused: ToolResult = { ok: true, data: { paused: true } };
    const pause = spyOn(commonModule, "pauseForUserInput").mockResolvedValue(paused);
    try {
      const h = harness(STDIO_DRAFT);
      const gate = await gateLocalCommandProbe(h.context, STDIO_DRAFT, { path: "/" });
      expect(gate.kind).toBe("stop");
      const call = pause.mock.calls[0]?.[1] as {
        tool_name: string;
        input: Record<string, unknown>;
      };
      expect(call.tool_name).toBe("ask_user_confirm");
      expect(call.input.kind).toBe("mcp_local_command");
      expect(String(call.input.question)).toContain("docker mcp gateway run");
      const spec = readLocalCommand(STDIO_DRAFT.config);
      expect(call.input.commit_intent).toMatchObject({
        kind: "confirm_local_command",
        payload: { command_sha256: spec ? localCommandFingerprint(spec) : "" },
      });
    } finally {
      pause.mockRestore();
    }
  });

  test("env values never appear in the question, only names", async () => {
    const pause = spyOn(commonModule, "pauseForUserInput").mockResolvedValue({
      ok: true,
      data: {},
    });
    try {
      const draft: ConnectorDraftDocument = {
        ...STDIO_DRAFT,
        config: {
          mcp: {
            ...(STDIO_DRAFT.config?.mcp as Record<string, unknown>),
            env: { LOG_LEVEL: "very-visible-value" },
            env_secret_names: ["API_TOKEN"],
            cwd: "/srv/mcp",
          },
        },
      };
      await gateLocalCommandProbe(harness(draft).context, draft, {});
      const question = String(
        (pause.mock.calls[0]?.[1] as { input?: Record<string, unknown> } | undefined)?.input
          ?.question,
      );
      expect(question).toContain("LOG_LEVEL");
      expect(question).toContain("API_TOKEN (secret)");
      expect(question).toContain("/srv/mcp");
      expect(question).not.toContain("very-visible-value");
    } finally {
      pause.mockRestore();
    }
  });
});
