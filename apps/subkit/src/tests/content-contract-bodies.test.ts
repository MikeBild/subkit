import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { AUDIT_SOURCE_HEADER } from "@shared/audit-source.ts";
import { runCommand } from "citty";
import { chatCommand } from "../commands/chat.ts";
import { knowledgeSourcesCommand } from "../commands/knowledge-sources.ts";
import { reviewCommand } from "../commands/review.ts";
import { skillCandidatesCommand } from "../commands/skill-candidates.ts";
import { skillsCommand } from "../commands/skills.ts";
import { EngineClient, type FetchLike } from "../engine-client.ts";

type Schemas = components["schemas"];

interface Seen {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: unknown;
  form: FormData | null;
}

type Route = (seen: Seen) => { status: number; body: unknown } | undefined;

const ENV_KEYS = [
  "SUBKIT_ENGINE_URL",
  "SUBKIT_API_KEY",
  "SUBKIT_TENANT",
  "SUBKIT_PROFILE",
] as const;

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;
let savedFetch: typeof globalThis.fetch;
let savedStdout: typeof process.stdout.write;
let savedStderr: typeof process.stderr.write;
let savedCwd: string;
let stdout: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subkit-content-contract-"));
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.SUBKIT_ENGINE_URL = "http://engine.test";
  process.env.SUBKIT_API_KEY = "wf_live_test_key";
  process.env.SUBKIT_TENANT = "00000000-0000-4000-8000-000000000002";
  delete process.env.SUBKIT_PROFILE;
  savedFetch = globalThis.fetch;
  savedCwd = process.cwd();
  stdout = "";
  savedStdout = process.stdout.write.bind(process.stdout);
  savedStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  process.stdout.write = savedStdout;
  process.stderr.write = savedStderr;
  process.chdir(savedCwd);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function record(input: Parameters<FetchLike>[0], init: Parameters<FetchLike>[1]): Seen {
  const url = new URL(String(input));
  const rawBody = init?.body;
  return {
    method: init?.method ?? "GET",
    path: url.pathname,
    search: url.search,
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: typeof rawBody === "string" ? JSON.parse(rawBody) : undefined,
    form: rawBody instanceof FormData ? rawBody : null,
  };
}

function reply(route: Route, seen: Seen): Response {
  const answer = route(seen) ?? { status: 404, body: { error: { code: "not_found" } } };
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { "content-type": "application/json" },
  });
}

function fakeEngine(route: Route): { client: EngineClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const entry = record(input, init);
    seen.push(entry);
    return reply(route, entry);
  };
  return {
    client: new EngineClient({ engine_url: "http://engine.test", api_key: "k", fetchImpl }),
    seen,
  };
}

function fakeGlobalEngine(route: Route): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const entry = record(input, init);
    seen.push(entry);
    return reply(route, entry);
  }) as typeof globalThis.fetch;
  return seen;
}

const TENANT = "00000000-0000-4000-8000-000000000002";
const STAMP = "2026-11-06T00:00:00.000Z";

const knowledgeSource = {
  id: "00000000-0000-4000-8000-00000000000a",
  tenant_id: TENANT,
  name: "Runbooks",
  slug: "runbooks",
  description: null,
  description_source: "human",
  category: "ops",
  category_source: "human",
  tags: ["ops"],
  scope: "workflow",
  workflow_id: "00000000-0000-4000-8000-00000000000b",
  status: "active",
  last_error: null,
  source_type: "bundle",
  source_uri: "bundle://runbooks",
  mime_type: null,
  version: "1",
  bytes_total: 10,
  chunk_count: 1,
  refresh_strategy: "manual",
  refresh_cron: null,
  last_refreshed_at: null,
  review_due_at: null,
  created_at: STAMP,
  updated_at: STAMP,
} satisfies Schemas["KnowledgeSource"];

const skillCandidate = {
  id: "00000000-0000-4000-8000-00000000000c",
  tenant_id: TENANT,
  scope: "global",
  connector_id: null,
  endpoint_key: null,
  workflow_id: null,
  pattern_kind: "repair_pattern",
  title: "Retry on 429",
  body: "Back off and retry.",
  examples: [],
  best_practices: [],
  pitfalls: [],
  doc_refs: [],
  facts: null,
  evidence_count: 2,
  confidence: "high",
  status: "proposed",
  promoted_skill_id: null,
  fingerprint: "fp-1",
  version: 1,
  tags: [],
  proposed_by: null,
  created_at: STAMP,
  updated_at: STAMP,
} satisfies Schemas["SkillCandidate"];

describe("knowledge-sources request bodies follow the contract", () => {
  test("import sends the bundle body with the contract scope", async () => {
    const dir = join(tmpDir, "bundle");
    mkdirSync(dir);
    writeFileSync(join(dir, "index.md"), "# Runbooks\n\nDeploy steps.\n");
    const seen = fakeGlobalEngine(({ method, path }) =>
      method === "POST" && path === "/v1/knowledge-sources/bundle"
        ? {
            status: 200,
            body: {
              knowledge_source: knowledgeSource,
              outcome: "created",
              ingested_count: 1,
              skipped_count: 0,
              skipped_files: [],
            } satisfies Schemas["KnowledgeBundleUpsertResponse"],
          }
        : undefined,
    );

    await runCommand(knowledgeSourcesCommand, {
      rawArgs: [
        "import",
        dir,
        "--name",
        "Runbooks",
        "--scope",
        "workflow",
        "--workflow-id",
        knowledgeSource.workflow_id,
        "--tags",
        "ops, deploy",
      ],
    });

    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /v1/knowledge-sources/bundle"]);
    expect(seen[0]?.body).toEqual({
      name: "Runbooks",
      tags: ["ops", "deploy"],
      scope: "workflow",
      workflow_id: knowledgeSource.workflow_id,
      files: [{ path: "/index.md", content: "# Runbooks\n\nDeploy steps.\n" }],
    } satisfies Schemas["CreateKnowledgeSourceBundleBody"]);
    expect(stripVTControlCharacters(stdout)).toContain(
      "created: Runbooks (runbooks) — 1 files, 1 chunks ingested, 0 skipped",
    );
  });

  test("import refuses a scope outside the contract before calling the engine", async () => {
    const dir = join(tmpDir, "bundle");
    mkdirSync(dir);
    writeFileSync(join(dir, "index.md"), "# Runbooks\n");
    const seen = fakeGlobalEngine(() => undefined);

    await expect(
      runCommand(knowledgeSourcesCommand, { rawArgs: ["import", dir, "--scope", "team"] }),
    ).rejects.toThrow("--scope must be one of: global, workflow");
    expect(seen).toEqual([]);
  });

  test("patch sends the update body with the contract status", async () => {
    const seen = fakeGlobalEngine(({ method }) =>
      method === "PATCH" ? { status: 200, body: knowledgeSource } : undefined,
    );

    await runCommand(knowledgeSourcesCommand, {
      rawArgs: [
        "patch",
        knowledgeSource.id,
        "--status",
        "inactive",
        "--tags",
        "a,b",
        "--name",
        "N",
      ],
    });

    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      `PATCH /v1/knowledge-sources/${knowledgeSource.id}`,
    ]);
    expect(seen[0]?.body).toEqual({
      name: "N",
      tags: ["a", "b"],
      status: "inactive",
    } satisfies Schemas["UpdateKnowledgeSourceBody"]);
  });

  test("patch refuses a status outside the contract before calling the engine", async () => {
    const seen = fakeGlobalEngine(() => undefined);

    await expect(
      runCommand(knowledgeSourcesCommand, {
        rawArgs: ["patch", knowledgeSource.id, "--status", "archived"],
      }),
    ).rejects.toThrow("--status must be one of: active, inactive");
    expect(seen).toEqual([]);
  });

  test("create sends metadata that parses as CreateKnowledgeSourceBody", async () => {
    const { client, seen } = fakeEngine(() => ({ status: 201, body: knowledgeSource }));

    const created = await client.createKnowledgeSource(
      {
        name: "notes.md",
        content: new TextEncoder().encode("# Notes\n"),
        mime_type: "text/markdown",
      },
      { name: "Notes", scope: "global", tags: ["ops"] },
    );

    expect(created.slug).toBe("runbooks");
    const metadata = seen[0]?.form?.get("metadata");
    expect(typeof metadata).toBe("string");
    expect(JSON.parse(String(metadata))).toEqual({
      name: "Notes",
      scope: "global",
      tags: ["ops"],
    } satisfies Schemas["CreateKnowledgeSourceBody"]);
  });
});

describe("skill reads follow the contract", () => {
  test("skill-candidates list shows the contract pattern_kind column", async () => {
    fakeGlobalEngine(({ path }) =>
      path === "/v1/skill-candidates"
        ? { status: 200, body: { items: [skillCandidate], reviewable_total: 1, total: 1 } }
        : undefined,
    );

    await runCommand(skillCandidatesCommand, { rawArgs: ["list"] });

    const [header, row] = stdout.trim().split("\n");
    expect(header?.split("\t")).toEqual(["id", "title", "pattern_kind", "status", "created_at"]);
    expect(row?.split("\t")).toEqual([
      skillCandidate.id,
      "Retry on 429",
      "repair_pattern",
      "proposed",
      STAMP,
    ]);
  });

  test("review summarises candidates from contract fields only", async () => {
    const patchCandidate = {
      id: "00000000-0000-4000-8000-00000000000d",
      workflow_id: "00000000-0000-4000-8000-00000000000e",
      workflow_name: "Invoice sync",
      status: "proposed",
      created_at: STAMP,
    } satisfies Partial<Schemas["PatchCandidate"]>;
    const seen = fakeGlobalEngine(({ path }) => {
      if (path === "/v1/patch-candidates")
        return { status: 200, body: { items: [patchCandidate], total: 1, reviewable_total: 1 } };
      if (path === "/v1/skill-candidates")
        return {
          status: 200,
          body: { items: [{ ...skillCandidate, title: "" }], reviewable_total: 1, total: 1 },
        };
      if (path === "/v1/executions")
        return { status: 200, body: { items: [], total: 0, next_cursor: null } };
      return undefined;
    });

    await runCommand(reviewCommand, { rawArgs: ["--json"] });

    expect(seen.find((s) => s.path === "/v1/skill-candidates")?.search).toBe(
      "?limit=10&status=proposed",
    );
    const printed = JSON.parse(stdout) as {
      patch_candidates: Array<{ summary: string }>;
      skill_candidates: Array<{ summary: string }>;
    };
    expect(printed.patch_candidates[0]?.summary).toBe(patchCandidate.workflow_id);
    expect(printed.skill_candidates[0]?.summary).toBe("(skill candidate)");
  });

  test("skills sync materialises contract skills with a null slug", async () => {
    const skill = {
      id: "00000000-0000-4000-8000-00000000000f",
      tenant_id: TENANT,
      scope: "global",
      connector_id: null,
      workflow_id: null,
      slug: null,
      title: "Deploy Rules",
      description: null,
      category: "ops",
      body: "Ship on green.",
      examples: [],
      best_practices: [],
      pitfalls: [],
      doc_refs: [],
      gates_tools: [],
      activates_when: [],
      input_schema: null,
      output_schema: null,
      side_effects: "none",
      idempotency: "naturally",
      maturity: "stable",
      tags: ["domain:blog"],
      applies_to: "both",
      audience: [],
      rules: [],
      domains: [],
      status: "active",
      source: "manual",
      version: 2,
      created_at: STAMP,
      updated_at: STAMP,
    } satisfies Schemas["Skill"];
    const other = { ...skill, id: "00000000-0000-4000-8000-000000000010", tags: [] };
    const seen = fakeGlobalEngine(({ path }) =>
      path === "/v1/skills"
        ? { status: 200, body: { items: [skill, other], total: 2 } }
        : undefined,
    );
    process.chdir(tmpDir);

    await runCommand(skillsCommand, { rawArgs: ["sync", "--domains", "blog", "--json"] });

    expect(seen[0]?.search).toBe("?status=active&limit=500");
    const written = join(tmpDir, ".claude/skills/deploy-rules/SKILL.md");
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, "utf8")).toContain("Ship on green.");
    expect(JSON.parse(stdout).skills).toBe(1);
  });
});

describe("chat install-space follows the contract", () => {
  test("sends the InstallChatWorkspace body for a contract platform", async () => {
    const seen = fakeGlobalEngine(({ method, path }) => {
      if (path === "/v1/chat/spaces/pending") return { status: 200, body: { items: [] } };
      if (method === "POST" && path === "/v1/chat/workspaces")
        return {
          status: 201,
          body: {
            id: "w-1",
            tenant_id: TENANT,
            platform: "slack",
            workspace_id: "T0123",
            default_channel: null,
            created_at: STAMP,
            updated_at: STAMP,
          } satisfies Schemas["ChatWorkspace"],
        };
      return undefined;
    });

    await runCommand(chatCommand, {
      rawArgs: ["install-space", "slack", "T0123", "--as", "U1", "--bot-token", "xoxb-1"],
    });

    expect(seen[1]?.body).toEqual({
      platform: "slack",
      workspace_id: "T0123",
      installer_platform_user_id: "U1",
      bot_token: "xoxb-1",
    } satisfies Schemas["InstallChatWorkspace"]);
    expect(stdout).toContain("installed slack space T0123");
  });

  test("refuses a platform outside the contract before installing", async () => {
    const seen = fakeGlobalEngine(({ path }) =>
      path === "/v1/chat/spaces/pending" ? { status: 200, body: { items: [] } } : undefined,
    );

    await expect(
      runCommand(chatCommand, { rawArgs: ["install-space", "discord", "X1", "--as", "U1"] }),
    ).rejects.toThrow("platform must be one of: slack, teams, google_chat");
    expect(seen.map((s) => s.path)).toEqual(["/v1/chat/spaces/pending"]);
  });
});

describe("conversation and settings bodies follow the contract", () => {
  const conversation = {
    id: "00000000-0000-4000-8000-000000000011",
    tenant_id: TENANT,
    target_workflow_id: null,
    target_connector_id: null,
    status: "active",
    owner_id: null,
    model: null,
    title: null,
    created_at: STAMP,
    updated_at: STAMP,
  } satisfies Schemas["Conversation"];

  test("respondElicitation sends RespondElicitationBody and reads pending_elicitation_id", async () => {
    const outcome = {
      conversation,
      events: [],
      status: "awaiting_input",
      pending_elicitation_id: "00000000-0000-4000-8000-000000000012",
    } satisfies Schemas["ConversationRunOutcome"];
    const { client, seen } = fakeEngine(() => ({ status: 200, body: outcome }));

    const result = await client.respondElicitation(
      conversation.id,
      "e-1",
      { confirmed: true },
      "looks right",
    );

    expect(seen[0]?.path).toBe(`/v1/conversations/${conversation.id}/elicitations/e-1/respond`);
    expect(seen[0]?.body).toEqual({
      output: { confirmed: true },
      reason: "looks right",
    } satisfies Schemas["RespondElicitationBody"]);
    expect(result.pending_elicitation_id).toBe(outcome.pending_elicitation_id);
  });

  test("setConversationToolPolicies sends ToolPoliciesPatchBody", async () => {
    const { client, seen } = fakeEngine(() => ({
      status: 200,
      body: {
        policies: { probe_connector: "no_confirm" },
        eligible_no_confirm_tools: ["probe_connector"],
      } satisfies Schemas["ToolPoliciesResponse"],
    }));

    const result = await client.setConversationToolPolicies(conversation.id, {
      probe_connector: "no_confirm",
      run_workflow: null,
    });

    expect(seen[0]?.method).toBe("PUT");
    expect(seen[0]?.body).toEqual({
      policies: { probe_connector: "no_confirm", run_workflow: null },
    } satisfies Schemas["ToolPoliciesPatchBody"]);
    expect(result.eligible_no_confirm_tools).toEqual(["probe_connector"]);
  });

  test("setSetting sends SettingPutBody with the subkit audit source", async () => {
    const { client, seen } = fakeEngine(() => ({
      status: 200,
      body: { value: "debug", requiresRestart: true } satisfies Schemas["SettingPutResult"],
    }));

    await client.setSetting("log.level", "debug", { tenant: TENANT, force: true });

    expect(seen[0]?.method).toBe("PUT");
    expect(seen[0]?.path).toBe("/v1/settings/log.level");
    expect(seen[0]?.search).toBe(`?tenant=${TENANT}`);
    expect(seen[0]?.headers[AUDIT_SOURCE_HEADER]).toBe("sk_cli");
    expect(seen[0]?.body).toEqual({
      value: "debug",
      force: true,
    } satisfies Schemas["SettingPutBody"]);
  });
});
