import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { _withEgressTenantOriginForTests } from "../../connectors/egress-guard.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { connectors, executionSteps } from "../../db/schema/index.ts";
import { startTestSftpServer, type TestSftpServer } from "../../test-helpers/sftp-server.ts";
import type { RequestStep } from "../../workflows/types.ts";
import { runExecution } from "../engine.ts";
import { requestRequiresPreparationHold } from "../steps/request/side-effects.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
let server: TestSftpServer;
let connectorId: string;
let wrongKeyConnectorId: string;

async function sftpConnector(slug: string, pin: string): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug,
      display_name: slug,
      driver: "sftp",
      environment: "dev",
      auth_type: "basic",
      base_url: `sftp://127.0.0.1:${server.port}/data`,
      config: { host_key_sha256: pin },
    })
    .returning();
  if (!row) throw new Error("sftp connector insert failed");
  await upsertCredential(
    {
      tenant_id: ctx.tenantId,
      connector_id: row.id,
      environment: "dev",
      mode: "basic",
      value: { mode: "basic", username: "transfer", password: "synthetic-password" },
      actor_id: null,
    },
    ctx.testDb.db,
  );
  return row.id;
}

function sftpStep(
  id: string,
  method: "LIST" | "GET" | "PUT" | "DELETE",
  path: string,
  extra: Record<string, unknown> = {},
) {
  return {
    kind: "request",
    protocol: "sftp",
    id,
    method,
    connector_id: connectorId,
    sftp: { path },
    ...extra,
  };
}

async function run(steps: unknown[], options: { hold_writes?: boolean } = {}) {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: `sftp-${Math.random().toString(36).slice(2, 8)}`,
    steps,
  });
  return runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: null,
    ...(options.hold_writes ? { options: { hold_writes: true } } : {}),
  });
}

async function stepRow(execution_id: string, step_key: string) {
  const [row] = await ctx.testDb.db
    .select()
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, ctx.tenantId),
        eq(executionSteps.execution_id, execution_id),
        eq(executionSteps.step_key, step_key),
      ),
    );
  return row;
}

beforeAll(async () => {
  ctx = await createEngineCtx("sftp-step");
  server = await startTestSftpServer(["transfer", "synthetic-password"]);
  connectorId = await sftpConnector("sftp-files", server.host_key_sha256);
  wrongKeyConnectorId = await sftpConnector(
    "sftp-wrong-key",
    "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  );
});

beforeEach(() => {
  server.files.clear();
  server.files.set("/data/reports/a.csv", Buffer.from("id,total\n1,10\n"));
  server.files.set("/data/reports/b.csv", Buffer.from("id,total\n2,20\n"));
  server.files.set("/data/secret.txt", Buffer.from("outside the folder"));
});

afterAll(async () => {
  await server.close();
  await ctx.cleanup();
});

describe("sftp request steps", () => {
  test("LIST returns the folder entries", async () => {
    const result = await run([sftpStep("list", "LIST", "reports")]);
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({
      path: "/data/reports",
      entries: [
        expect.objectContaining({ name: "a.csv", path: "/data/reports/a.csv", type: "file" }),
        expect.objectContaining({ name: "b.csv", path: "/data/reports/b.csv", type: "file" }),
      ],
    });
  });

  test("GET returns the file as a run file", async () => {
    const result = await run([sftpStep("download", "GET", "reports/a.csv")]);
    expect(result.status).toBe("succeeded");
    const output = result.output as {
      file: { $file: string };
      filename: string;
      size_bytes: number;
    };
    expect(output.file.$file).toMatch(/^fid_/);
    expect(output.filename).toBe("a.csv");
    expect(output.size_bytes).toBe(Buffer.byteLength("id,total\n1,10\n"));
  });

  test("PUT uploads the body and stamps the write before it leaves", async () => {
    const result = await run([sftpStep("upload", "PUT", "outbox/c.txt", { body: "hello" })]);
    expect(result.status).toBe("succeeded");
    expect(server.files.get("/data/outbox/c.txt")?.toString("utf8")).toBe("hello");
    expect((await stepRow(result.execution_id, "upload"))?.write_dispatched_at).not.toBeNull();
  });

  test("a path that climbs out of the root folder is refused", async () => {
    const sessions = server.sessions();
    const result = await run([sftpStep("escape", "GET", "../secret.txt")]);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("sftp_path_outside_root");
    expect(server.sessions()).toBe(sessions);
  });

  test("DELETE removes one file in a direct run", async () => {
    const result = await run([sftpStep("remove", "DELETE", "reports/a.csv")]);
    expect(result.status).toBe("succeeded");
    expect(server.files.has("/data/reports/a.csv")).toBe(false);
  });

  test("held writes leave the server untouched while reads still run", async () => {
    const sessions = server.sessions();
    const result = await run(
      [
        sftpStep("list", "LIST", "reports"),
        sftpStep("upload", "PUT", "outbox/c.txt", { body: "hello" }),
        sftpStep("remove", "DELETE", "reports/a.csv"),
      ],
      { hold_writes: true },
    );
    expect(result.status).toBe("succeeded");
    expect(result.steps[0]?.held).toBeFalsy();
    expect(result.steps[1]?.held).toBe(true);
    expect(result.steps[2]?.held).toBe(true);
    expect(server.files.has("/data/outbox/c.txt")).toBe(false);
    expect(server.files.has("/data/reports/a.csv")).toBe(true);
    expect(server.sessions()).toBe(sessions + 1);
  });

  test("PUT and DELETE need a reviewed preparation, LIST and GET do not", () => {
    const step = (method: string) =>
      sftpStep("s", method as "LIST", "reports/a.csv") as unknown as RequestStep;
    expect(requestRequiresPreparationHold(step("PUT"), "sftp")).toBe(true);
    expect(requestRequiresPreparationHold(step("DELETE"), "sftp")).toBe(true);
    expect(requestRequiresPreparationHold(step("LIST"), "sftp")).toBe(false);
    expect(requestRequiresPreparationHold(step("GET"), "sftp")).toBe(false);
  });

  test("a server whose host key differs from the pin is refused before sign-in", async () => {
    const result = await run([
      {
        ...sftpStep("upload", "PUT", "outbox/c.txt", { body: "x" }),
        connector_id: wrongKeyConnectorId,
      },
    ]);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("sftp_host_key_mismatch");
    expect(server.files.has("/data/outbox/c.txt")).toBe(false);
  });

  test("egress to a private address is refused under the strict guard", async () => {
    const sessions = server.sessions();
    const result = await _withEgressTenantOriginForTests(
      async () => "self_service",
      () => run([sftpStep("list", "LIST", "reports")]),
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("egress_blocked");
    expect(server.sessions()).toBe(sessions);
  });
});
