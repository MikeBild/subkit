// Engine test scaffolding.
//
// Each test that needs the engine builds:
//   - a disposable Postgres database (P1 helper)
//   - a tenant + workflow row referencing a hand-crafted dag
//   - optionally, a local mock HTTP server on a random port
//
// `createMockServer` is a thin wrapper around `node:http` so a test can
// queue up canned responses for sequential calls. Returns the base URL and
// a disposer.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tenants, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { type WorkflowDef, WorkflowDefSchema } from "../../workflows/types.ts";

export interface EngineTestCtx {
  testDb: TestDb;
  tenantId: string;
  cleanup: () => Promise<void>;
}

export async function createEngineCtx(label: string): Promise<EngineTestCtx> {
  const testDb = await createTestDb(`engine-${label}`);
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: `et-${label}`, display_name: `Engine ${label}` })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  return {
    testDb,
    tenantId: tenant.id,
    cleanup: async () => {
      await testDb.cleanup();
    },
  };
}

export async function createWorkflowRow(
  ctx: EngineTestCtx,
  rawDef: unknown,
): Promise<{ workflow_id: string; version_id: string }> {
  // Parse to fill in defaults so the engine sees the canonical shape.
  const def: WorkflowDef = WorkflowDefSchema.parse(rawDef);
  const [wf] = await ctx.testDb.db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenantId,
      slug: def.slug ?? `wf-${Math.random().toString(36).slice(2, 8)}`,
      name: def.name,
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("workflow insert failed");
  const [v] = await ctx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: wf.id,
      version: 1,
      dag: def,
    })
    .returning();
  if (!v) throw new Error("workflow_versions insert failed");
  const { eq } = await import("drizzle-orm");
  await ctx.testDb.db
    .update(workflows)
    .set({ current_version_id: v.id })
    .where(eq(workflows.id, wf.id));
  return { workflow_id: wf.id, version_id: v.id };
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

export interface MockServer {
  baseUrl: string;
  setHandler: (h: Handler) => void;
  callCount: () => number;
  close: () => Promise<void>;
}

export async function createMockServer(initial: Handler): Promise<MockServer> {
  let handler: Handler = initial;
  let count = 0;
  const server: Server = createServer(async (req, res) => {
    count += 1;
    try {
      await handler(req, res);
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    setHandler: (h) => {
      handler = h;
    },
    callCount: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
