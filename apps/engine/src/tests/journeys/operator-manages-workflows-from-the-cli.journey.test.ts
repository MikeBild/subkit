import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { defineCommand } from "citty";
import { and, eq } from "drizzle-orm";
import { connectorsCommand } from "../../../../subkit/src/commands/connectors.ts";
import { executionsCommand } from "../../../../subkit/src/commands/executions.ts";
import { workflowsCommand } from "../../../../subkit/src/commands/workflows.ts";
import { auditLog, executions } from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { waitFor } from "../../test-helpers/determinism/index.ts";
import {
  type Captured,
  extractLastJson,
  isLogLine,
  patchStd,
  withEnv,
  withNoExit,
} from "./cli-capture.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

describe("an operator manages workflows, connectors and runs from the subkit CLI", () => {
  describe("subkit workflows", () => {
    const TEST_NOW_MS = getTestNow();

    let ctx: JourneyCtx;

    async function run(
      command: ReturnType<typeof defineCommand>,
      cmdPath: string[],
      extraArgs: string[] = [],
    ): Promise<Captured> {
      const cli = patchStd();
      const argv = [...cmdPath, "--json", ...extraArgs];
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: argv });
          }),
        );
      } finally {
        cli.restore();
      }
      return { stdout: cli.stdout, stderr: cli.stderr };
    }

    async function runExpectError(
      command: ReturnType<typeof defineCommand>,
      cmdPath: string[],
      extraArgs: string[] = [],
    ): Promise<{ message: string; captured: Captured }> {
      const cli = patchStd();
      const argv = [...cmdPath, "--json", ...extraArgs];
      let message = "";
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: argv });
          }),
        );
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      } finally {
        cli.restore();
      }
      return { message, captured: { stdout: cli.stdout, stderr: cli.stderr } };
    }

    async function runPlain(
      command: ReturnType<typeof defineCommand>,
      cmdPath: string[],
      extraArgs: string[] = [],
    ): Promise<Captured> {
      const cli = patchStd();
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: [...cmdPath, ...extraArgs] });
          }),
        );
      } finally {
        cli.restore();
      }
      return { stdout: cli.stdout, stderr: cli.stderr };
    }

    const fixture = {
      name: "test-wf",
      slug: "test-wf",
      steps: [
        { kind: "transform", id: "step1", language: "javascript", expression: "({ ok: true })" },
      ],
    };

    const tmpFile = path.join(tmpdir(), `35-cli-wf-${TEST_NOW_MS}.json`);

    let createdId = "";

    beforeAll(async () => {
      ctx = await createJourneyCtx("cli-workflows");
      writeFileSync(tmpFile, JSON.stringify(fixture));
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      if (ctx?.cleanup) await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1: workflows list returns empty array before any workflows exist", async () => {
      const { stdout } = await run(workflowsCommand, ["list"]);
      const body = JSON.parse(extractLastJson(stdout));
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(0);
    });

    test("AC2: workflows create from file produces a workflow with id, name, slug", async () => {
      const { stdout } = await run(workflowsCommand, ["create"], ["--file", tmpFile]);
      const body = JSON.parse(extractLastJson(stdout));
      expect(typeof body.id).toBe("string");
      expect(body.id.length).toBeGreaterThan(0);
      expect(body.name).toBe("test-wf");
      expect(body.slug).toBe("test-wf");
      createdId = body.id as string;
    });

    test("AC3: workflows list after create returns at least 1 item containing the new workflow", async () => {
      const { stdout } = await run(workflowsCommand, ["list"]);
      const body = JSON.parse(extractLastJson(stdout));
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      const ids = (body as Array<{ id: string }>).map((w) => w.id);
      expect(ids).toContain(createdId);
    });

    test("AC4: workflows get returns the workflow with correct name", async () => {
      const { stdout } = await run(workflowsCommand, ["get", createdId]);
      const body = JSON.parse(extractLastJson(stdout));
      expect(body.id).toBe(createdId);
      expect(body.name).toBe("test-wf");
      expect(body.slug).toBe("test-wf");
    });

    test("AC5: workflows history returns 1 version at version=1 initially", async () => {
      const { stdout } = await run(workflowsCommand, ["history", createdId]);
      const body = JSON.parse(extractLastJson(stdout));
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(1);
      const v1 = (body as Array<{ version: number }>)[0];
      expect(v1?.version).toBe(1);
    });

    test("AC6: after a PUT via HTTP, history returns 2 versions", async () => {
      const patchResp = await journeyFetch(ctx, `/v1/workflows/${createdId}`, {
        method: "PUT",
        body: JSON.stringify({
          name: "test-wf-v2",
          slug: "test-wf",
          steps: fixture.steps,
        }),
      });
      expect(patchResp.status).toBe(200);

      const { stdout } = await run(workflowsCommand, ["history", createdId]);
      const body = JSON.parse(extractLastJson(stdout));
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
      const versions = (body as Array<{ version: number }>).map((v) => v.version);
      expect(versions).toContain(1);
      expect(versions).toContain(2);
    });

    test("AC7: workflows restore <id> 1 creates a new version pointing at v1 dag", async () => {
      const { stdout } = await run(workflowsCommand, ["restore", createdId, "1"]);
      const body = JSON.parse(extractLastJson(stdout));
      expect(body.id).toBe(createdId);
      expect(typeof body.current_version_id).toBe("string");
      expect(body.current_version_id.length).toBeGreaterThan(0);
      expect(typeof body.current_version).toBe("number");
      expect(body.current_version as number).toBeGreaterThanOrEqual(2);
    });

    test("AC8: workflows delete outputs 'deleted'", async () => {
      const { stdout } = await runPlain(workflowsCommand, ["delete", createdId]);
      const nonLogLines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => {
          if (!l) return false;
          try {
            const p = JSON.parse(l);
            if (isLogLine(p)) return false;
          } catch {}
          return true;
        });
      expect(nonLogLines).toContain("deleted");
    });

    test("AC9: workflows get after delete returns not_found error", async () => {
      const { message, captured } = await runExpectError(workflowsCommand, ["get", createdId]);
      const combined = `${message}\n${captured.stderr}`.toLowerCase();
      expect(
        combined.includes("not_found") ||
          combined.includes("404") ||
          combined.includes("not found") ||
          combined.includes("process.exit"),
      ).toBe(true);
    });
  });

  describe("subkit connectors", () => {
    let ctx: JourneyCtx;

    let connectorId = "";

    const connectorDisplayName = "Journey HTTP Connector";

    async function run(
      command: import("citty").CommandDef,
      path: string[],
      extraArgs: string[] = [],
    ): Promise<Captured> {
      const cli = patchStd();
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: [...path, "--json", ...extraArgs] });
          }),
        );
      } finally {
        cli.restore();
      }
      return { stdout: cli.stdout, stderr: cli.stderr };
    }

    async function runPlain(
      command: import("citty").CommandDef,
      path: string[],
      extraArgs: string[] = [],
    ): Promise<Captured> {
      const cli = patchStd();
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: [...path, ...extraArgs] });
          }),
        );
      } finally {
        cli.restore();
      }
      return { stdout: cli.stdout, stderr: cli.stderr };
    }

    async function runExpectError(
      command: import("citty").CommandDef,
      path: string[],
      extraArgs: string[] = [],
    ): Promise<{ message: string; captured: Captured }> {
      const cli = patchStd();
      let message = "";
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: [...path, "--json", ...extraArgs] });
          }),
        );
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      } finally {
        cli.restore();
      }
      return { message, captured: { stdout: cli.stdout, stderr: cli.stderr } };
    }

    beforeAll(async () => {
      ctx = await createJourneyCtx("cli-connectors");

      const resp = await journeyFetch(ctx, "/v1/connectors", {
        method: "POST",
        body: JSON.stringify({
          slug: "journey-http",
          name: connectorDisplayName,
          driver: "http",
          environment: "dev",
          auth_type: "none",
          base_url: "https://example.test",
        }),
      });
      expect(resp.status).toBe(201);
      const body = (await resp.json()) as { id: string; display_name: string };
      connectorId = body.id;
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      if (ctx?.cleanup) await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1: connectors list --json returns an array initially", async () => {
      const { stdout } = await run(connectorsCommand, ["list"]);
      const body = JSON.parse(extractLastJson(stdout));
      expect(Array.isArray(body)).toBe(true);
    });

    test("AC2: connectors get <id> returns the correct connector", async () => {
      const { stdout } = await run(connectorsCommand, ["get", connectorId]);
      const body = JSON.parse(extractLastJson(stdout)) as { id: string; display_name: string };
      expect(body.id).toBe(connectorId);
      expect(body.display_name).toBe(connectorDisplayName);
    });

    test("AC3: connectors patch <id> --name updates the display_name", async () => {
      const { stdout } = await run(
        connectorsCommand,
        ["patch", connectorId],
        ["--name", "Updated Name"],
      );
      const body = JSON.parse(extractLastJson(stdout)) as { id: string; display_name: string };
      expect(body.id).toBe(connectorId);
      expect(body.display_name).toBe("Updated Name");
    });

    test("AC4: connectors list --json after create shows at least 1 item", async () => {
      const { stdout } = await run(connectorsCommand, ["list"]);
      const body = JSON.parse(extractLastJson(stdout)) as Array<{ id: string }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body.some((c) => c.id === connectorId)).toBe(true);
    });

    test("AC5: connectors delete <id> --yes outputs 'deleted'", async () => {
      const { stdout } = await runPlain(connectorsCommand, ["delete", connectorId], ["--yes"]);
      expect(stdout.toLowerCase()).toContain("deleted");
    });

    test("AC6: connectors get <id> after delete produces an error", async () => {
      const { message, captured } = await runExpectError(connectorsCommand, ["get", connectorId]);
      const combined = `${message}\n${captured.stderr}`.toLowerCase();
      expect(
        combined.includes("404") ||
          combined.includes("not found") ||
          combined.includes("process.exit") ||
          combined.includes("notfound"),
      ).toBe(true);
    });
  });

  describe("subkit executions", () => {
    let ctx: JourneyCtx;

    let wfId = "";

    let executionId = "";

    let abortWfId = "";

    let abortExecutionId = "";

    async function run(
      command: ReturnType<typeof defineCommand>,
      cmdPath: string[],
      extraArgs: string[] = [],
    ): Promise<Captured> {
      const cli = patchStd();
      const argv = [...cmdPath, "--json", ...extraArgs];
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: argv });
          }),
        );
      } finally {
        cli.restore();
      }
      return { stdout: cli.stdout, stderr: cli.stderr };
    }

    async function runExpectError(
      command: ReturnType<typeof defineCommand>,
      cmdPath: string[],
      extraArgs: string[] = [],
    ): Promise<{ message: string; captured: Captured }> {
      const cli = patchStd();
      const argv = [...cmdPath, "--json", ...extraArgs];
      let message = "";
      try {
        await withEnv(ctx.baseUrl, ctx.apiKey, () =>
          withNoExit(async () => {
            const citty = await import("citty");
            await citty.runCommand(command, { rawArgs: argv });
          }),
        );
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      } finally {
        cli.restore();
      }
      return { message, captured: { stdout: cli.stdout, stderr: cli.stderr } };
    }

    beforeAll(async () => {
      ctx = await createJourneyCtx("cli-executions");

      const wf = await seedWorkflow(ctx, {
        slug: "exec-test-wf",
        name: "exec-test-wf",
        steps: [{ kind: "transform", id: "t1", expression: "$input" }],
      });
      wfId = wf.id;

      const runResp = await journeyFetch(ctx, "/v1/executions", {
        method: "POST",
        body: JSON.stringify({ source: "saved", workflow_id: wfId, input: {} }),
      });
      expect(runResp.status).toBe(200);
      const runData = (await runResp.json()) as { execution_id: string };
      executionId = runData.execution_id;

      const abortWf = await seedWorkflow(ctx, {
        slug: "abort-test-wf",
        name: "abort-test-wf",
        steps: [
          {
            kind: "request",
            id: "s1",
            method: "GET",
            url: "http://192.0.2.1/delay/30",
          },
        ],
      });
      abortWfId = abortWf.id;

      const abortRunResp = await journeyFetch(ctx, "/v1/executions", {
        method: "POST",
        body: JSON.stringify({ source: "saved", workflow_id: abortWfId, input: {}, async: true }),
      });
      expect(abortRunResp.status).toBe(202);
      const abortRunData = (await abortRunResp.json()) as { execution_id: string };
      abortExecutionId = abortRunData.execution_id;
    }, JOURNEY_HOOK_TIMEOUT);

    afterAll(async () => {
      if (ctx?.cleanup) await ctx.cleanup();
    }, JOURNEY_HOOK_TIMEOUT);

    test("AC1: executions list returns an array after seeding a run", async () => {
      const { stdout } = await run(executionsCommand, ["list"]);
      const body = JSON.parse(extractLastJson(stdout));
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      const ids = (body as Array<{ id: string }>).map((e) => e.id);
      expect(ids).toContain(executionId);
    });

    test("AC2: executions list --status running returns an array", async () => {
      const { stdout } = await run(executionsCommand, ["list"], ["--status=running"]);
      const body = JSON.parse(extractLastJson(stdout));
      expect(Array.isArray(body)).toBe(true);
    });

    test("AC3: executions get returns the execution with id, workflow_id, status", async () => {
      const { stdout } = await run(executionsCommand, ["get", executionId]);
      const body = JSON.parse(extractLastJson(stdout));
      expect(body.id).toBe(executionId);
      expect(body.workflow_id).toBe(wfId);
      expect(typeof body.status).toBe("string");
      expect(body.status.length).toBeGreaterThan(0);
    });

    test("AC4: executions steps returns an array", async () => {
      const { stdout } = await run(executionsCommand, ["steps", executionId]);
      const body = JSON.parse(extractLastJson(stdout));
      expect(Array.isArray(body)).toBe(true);
    });

    test("AC5: CLI cancellation is durable, audited, and reaches a terminal state", async () => {
      const { stdout: abortStdout } = await run(executionsCommand, ["abort", abortExecutionId]);
      expect(abortStdout).toContain("aborted");

      const persisted = await waitFor(
        async () => {
          const [row] = await ctx.db
            .select()
            .from(executions)
            .where(
              and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, abortExecutionId)),
            );
          return row && ["aborted", "failed"].includes(row.status) ? row : undefined;
        },
        { tries: 100, sleepMs: 20, label: "cancelled execution terminal" },
      );
      expect(persisted.abort_requested_at).toBeInstanceOf(Date);
      expect(["aborted", "failed"]).toContain(persisted.status);

      const abortAudits = await ctx.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, ctx.tenantId),
            eq(auditLog.resource_id, abortExecutionId),
            eq(auditLog.action, "execution.abort_requested"),
          ),
        );
      expect(abortAudits).toHaveLength(1);

      const { stdout: getStdout } = await run(executionsCommand, ["get", abortExecutionId]);
      const body = JSON.parse(extractLastJson(getStdout));
      expect(body.id).toBe(abortExecutionId);
      expect(["aborted", "failed"]).toContain(body.status);
    });

    test("AC6: executions get with wrong-tenant id returns an error", async () => {
      const fakeId = "00000000-0000-4000-8000-000000000042";
      const { message, captured } = await runExpectError(executionsCommand, ["get", fakeId]);
      const combined = `${message}\n${captured.stderr}`.toLowerCase();
      expect(
        combined.includes("not_found") ||
          combined.includes("404") ||
          combined.includes("not found") ||
          combined.includes("process.exit"),
      ).toBe(true);
    });
  });
});
