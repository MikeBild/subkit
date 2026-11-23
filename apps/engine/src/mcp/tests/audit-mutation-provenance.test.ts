import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runCommand } from "citty";
import { eq } from "drizzle-orm";
import { knowledgeSourcesCommand } from "../../../../subkit/src/commands/knowledge-sources.ts";
import { MCP_ADMIN_SCOPE } from "../../auth/scopes.ts";
import { files } from "../../db/schema/index.ts";
import { removeStoredFile } from "../../files/remove-stored-file.ts";
import { browserSessionHeaders } from "../../http/tests/setup.ts";
import { runWithTestEnv } from "../../test-helpers/determinism/env.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

type Source = {
  id: string;
  name: string;
};

type AuditRow = {
  tenant_id: string;
  actor_type: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  result: string;
  origin_source: string | null;
  execution_source: string | null;
  access_type: string | null;
  api_key_id: string | null;
  session_id: string | null;
  ip: null;
  user_agent: null;
  before: null;
  after: null;
};

let suite: McpTestSuite;
let fixtureDir: string;
let mutationsCompleted = false;

beforeAll(async () => {
  suite = await startMcpTestSuite("audit-mutation-provenance");
  fixtureDir = mkdtempSync(join(tmpdir(), "subkit-audit-provenance-"));
});

afterAll(async () => {
  try {
    if (suite) {
      const uploaded = await suite.http.db
        .select({ id: files.id, filename: files.filename })
        .from(files)
        .where(eq(files.tenant_id, suite.http.tenantId));
      const uploadedNames = uploaded.map((file) => file.filename).sort();
      const removedIds: string[] = [];
      const removalErrors: unknown[] = [];
      for (const file of uploaded) {
        try {
          const removed = await removeStoredFile(suite.http.db, suite.http.tenantId, file.id);
          if (removed) removedIds.push(removed.id);
        } catch (error) {
          removalErrors.push(error);
        }
      }
      expect(removalErrors).toEqual([]);
      expect(removedIds.sort()).toEqual(uploaded.map((file) => file.id).sort());
      if (mutationsCompleted) {
        expect(uploadedNames).toEqual(
          ["Audit cockpit source.md", "Audit HTTP source.md", "audit-cli-source.md"].sort(),
        );
      }
    }
  } finally {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    if (suite) await suite.cleanup();
  }
});

async function postInline(name: string, headers: Record<string, string>): Promise<Source> {
  const response = await fetch(`${suite.http.baseUrl}/v1/knowledge-sources/inline`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, content: `# ${name}\n\nAudit provenance fixture.` }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Source;
}

async function readCreated(
  source: Source,
  resourceType = "knowledge_source",
  action = "knowledge_source.created",
): Promise<AuditRow> {
  const response = await fetch(
    `${suite.http.baseUrl}/v1/audit-log?resource_type=${resourceType}&resource_id=${encodeURIComponent(source.id)}&action=${action}`,
    { headers: { authorization: `Bearer ${suite.http.apiKey}` } },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: AuditRow[] };
  const rows = body.items.filter((row) => row.action === action);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) throw new Error(`missing audit row for ${source.id}`);
  expect(row).toMatchObject({
    tenant_id: suite.http.tenantId,
    actor_type: "user",
    actor_id: suite.http.userId,
    resource_type: resourceType,
    resource_id: source.id,
    result: "success",
    ip: null,
    user_agent: null,
    before: null,
    after: null,
  });
  return row;
}

test("browser session, HTTP, subkit over HTTP, and MCP mutations retain audit provenance", async () => {
  const cockpitHeaders = await browserSessionHeaders(suite.http, suite.http.userId);
  const cockpit = await postInline("Audit cockpit source", {
    ...cockpitHeaders,
    "x-subkit-client": "cockpit",
  });
  const http = await postInline("Audit HTTP source", {
    authorization: `Bearer ${suite.http.apiKey}`,
    "content-type": "application/json",
  });

  const cliFile = join(fixtureDir, "audit-cli-source.md");
  writeFileSync(cliFile, "# Audit CLI source\n\nAudit provenance fixture.\n");
  const originalWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await runWithTestEnv(
      {
        SUBKIT_PROFILE: basename(fixtureDir),
        SUBKIT_ENGINE_URL: suite.http.baseUrl,
        SUBKIT_API_KEY: suite.http.apiKey,
        SUBKIT_TENANT: suite.http.tenantId,
      },
      () =>
        runCommand(knowledgeSourcesCommand, {
          rawArgs: ["create", `--file=${cliFile}`, "--name=Audit CLI source", "--json"],
        }),
    );
  } finally {
    process.stdout.write = originalWrite;
  }
  const cliList = await fetch(`${suite.http.baseUrl}/v1/knowledge-sources?limit=50`, {
    headers: { authorization: `Bearer ${suite.http.apiKey}` },
  });
  expect(cliList.status).toBe(200);
  const cliItems = (await cliList.json()) as { items: Source[] };
  const cli = cliItems.items.find((item) => item.name === "Audit CLI source");
  if (!cli) throw new Error("CLI fixture was not created");

  const mcpKey = await suite.issueApiKey([MCP_ADMIN_SCOPE]);
  const mcpClient = await suite.connectWithApiKey(mcpKey.plaintext);
  const mcpResult = await mcpClient.callTool({
    name: "create_knowledge_source",
    arguments: {
      mode: "inline",
      name: "Audit MCP source",
      content: "# Audit MCP source\n\nAudit provenance fixture.",
    },
  });
  expect(mcpResult.isError).toBeFalsy();
  const [mcpText] = mcpResult.content as { type: string; text: string }[];
  const collected = JSON.parse(mcpText?.text ?? "{}") as {
    collected?: boolean;
    intake_item?: { id: string; title: string };
  };
  expect(collected.collected).toBe(true);
  const intakeItem = collected.intake_item;
  if (!intakeItem) throw new Error("MCP intake item was not collected");
  const mcp: Source = { id: intakeItem.id, name: intakeItem.title };
  mutationsCompleted = true;

  const [cockpitAudit, httpAudit, cliAudit, mcpAudit] = await Promise.all([
    readCreated(cockpit),
    readCreated(http),
    readCreated(cli),
    readCreated(mcp, "intake_item", "intake_item.collected"),
  ]);
  expect(cockpitAudit).toMatchObject({
    origin_source: "ui",
    execution_source: "ui",
    access_type: "browser_session",
    api_key_id: null,
  });
  expect(cockpitAudit.session_id).not.toBeNull();
  expect(httpAudit).toMatchObject({
    origin_source: "api",
    execution_source: "api",
    access_type: "api_key",
    api_key_id: suite.http.apiKeyId,
    session_id: null,
  });
  expect(cliAudit).toMatchObject({
    origin_source: "api",
    execution_source: "api",
    access_type: "api_key",
    api_key_id: suite.http.apiKeyId,
    session_id: null,
  });
  expect(mcpAudit.origin_source).toBe("mcp");
  expect(mcpAudit.execution_source).toBe("mcp");
  expect(mcpAudit.access_type).toBe("api_key");
  expect(mcpAudit.api_key_id).not.toBeNull();
});
