import { afterAll, beforeAll } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { ToolContext } from "../../conversations/tools/index.ts";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";

let policyFixture: TestDb;

export function usePolicyFixture(additionalTenants: readonly string[] = []): void {
  beforeAll(async () => {
    policyFixture = await createTestDb("tool-policy-fixture");
    await policyFixture.db.insert(tenants).values(
      [makeTestPrincipal().tenant_id, ...additionalTenants].map((id, index) => ({
        id,
        slug: `tool-policy-fixture-${index}`,
        display_name: "Tool Policy Fixture",
      })),
    );
  }, 120_000);

  afterAll(async () => {
    await policyFixture?.cleanup();
  }, 120_000);
}

export function makeTestPrincipal(overrides: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    provider: "test",
    kind: "user",
    id: "00000000-0000-4000-8000-000000000001",
    tenant_id: "00000000-0000-4000-8000-000000000002",
    authoring_role_id: null,
    scopes: [],
    permission_grants: [],
    role_ids: [],
    api_key_id: null,
    ...overrides,
  } as unknown as ResolvedPrincipal;
}

interface StubChain {
  set(): StubChain;
  where(): StubChain;
  returning(): Promise<unknown[]>;
}

interface StubDbCapture {
  inserts: Array<{
    action: string | undefined;
    resource_type: string | undefined;
    resource_id: string | undefined;
    tenant_id: string | undefined;
  }>;
}

export function makeStubDb(): { db: Db; capture: StubDbCapture } {
  const capture: StubDbCapture = { inserts: [] };
  const emptyUpdate: StubChain = {
    set: () => emptyUpdate,
    where: () => emptyUpdate,
    returning: () => Promise.resolve([]),
  };
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    select: (...args: Parameters<Db["select"]>) => policyFixture.db.select(...args),
    update: () => emptyUpdate,
    insert: () => ({
      values: (row: Partial<Record<keyof StubDbCapture["inserts"][number], string>>) => {
        capture.inserts.push({
          action: row?.action,
          resource_type: row?.resource_type,
          resource_id: row?.resource_id,
          tenant_id: row?.tenant_id,
        });
        return { onConflictDoNothing: async () => undefined };
      },
    }),
  };
  return { db: db as unknown as Db, capture };
}

export function makeStubCtx(opts: { db: Db; principal: ResolvedPrincipal }): ToolContext {
  return {
    db: opts.db,
    tenant_id: opts.principal.tenant_id,
    conversation_id: "00000000-0000-0000-0000-000000000003",
    actor_id: opts.principal.id,
    connector_id: null,
    workflow_id: null,
    engineClient: {} as ToolContext["engineClient"],
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  } as ToolContext;
}
