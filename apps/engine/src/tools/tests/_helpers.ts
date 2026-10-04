import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { ToolContext } from "../../conversations/tools/index.ts";
import type { Db } from "../../db/client.ts";

export function makeTestPrincipal(overrides: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    kind: "user",
    id: "00000000-0000-0000-0000-000000000001",
    tenant_id: "00000000-0000-0000-0000-000000000002",
    authoring_role_id: null,
    scopes: new Set(),
    permission_grants: [],
    role_ids: [],
    api_key_id: null,
    // biome-ignore lint/suspicious/noExplicitAny: ResolvedPrincipal carries fields the dispatcher never reads; fill at boundary
    ...(overrides as any),
    // biome-ignore lint/suspicious/noExplicitAny: stub
  } as any;
}

export interface StubDbCapture {
  inserts: Array<{
    action?: string;
    resource_type?: string;
    resource_id?: string;
    tenant_id?: string;
  }>;
}

export function makeStubDb(): { db: Db; capture: StubDbCapture } {
  const capture: StubDbCapture = { inserts: [] };
  // biome-ignore lint/suspicious/noExplicitAny: drizzle chain shape
  const emptySelect: any = {
    from: () => emptySelect,
    where: () => emptySelect,
    leftJoin: () => emptySelect,
    innerJoin: () => emptySelect,
    limit: () => Promise.resolve([]),
    orderBy: () => Promise.resolve([]),
  };
  // biome-ignore lint/suspicious/noExplicitAny: drizzle chain shape
  const emptyUpdate: any = {
    set: () => emptyUpdate,
    where: () => emptyUpdate,
    returning: () => Promise.resolve([]),
  };
  // biome-ignore lint/suspicious/noExplicitAny: drizzle Db shape
  const db: any = {
    // biome-ignore lint/suspicious/noExplicitAny: transaction wrapper
    transaction: async (fn: any) => fn(db),
    select: () => emptySelect,
    update: () => emptyUpdate,
    insert: () => ({
      // biome-ignore lint/suspicious/noExplicitAny: drizzle insert chain
      values: (row: any) => {
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
  return { db: db as Db, capture };
}

export function makeStubCtx(opts: { db: Db; principal: ResolvedPrincipal }): ToolContext {
  return {
    db: opts.db,
    tenant_id: opts.principal.tenant_id,
    conversation_id: "00000000-0000-0000-0000-000000000003",
    actor_id: opts.principal.id,
    connector_id: null,
    workflow_id: null,
    // biome-ignore lint/suspicious/noExplicitAny: EngineClient stub
    engineClient: {} as any,
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  } as ToolContext;
}
