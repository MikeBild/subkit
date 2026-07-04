// Test helpers for the unified-tool-palette suite.
//
// Two reasons to live here rather than alongside each test file:
//   1. Avoid drift in the `ResolvedPrincipal` / `Db` test stubs across
//      half a dozen tests.
//   2. Centralize the `as any` casts that AGENTS bans in production
//      code — concentrated in one helper, each test consumes typed
//      values.

import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { ToolContext } from "../../conversations/tools/index.ts";
import type { Db } from "../../db/client.ts";

/** Build a deterministic ResolvedPrincipal for unit tests. Override
 *  any field; defaults are tenant-A / user-1 / no permissions. */
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

/** Build a Drizzle-flavored stub `Db` that:
 *   - captures every `insert(...).values({...})` row into `capture.inserts`
 *     so audit emissions are testable without Postgres.
 *   - returns empty result sets from every `select()` chain — used by
 *     `can()`'s permission-catalog lookup; an empty catalog means
 *     every permission lookup denies cleanly without throwing.
 *   - threads through transactions as no-ops.
 *
 *  Returns `{ db, capture }` so the test can assert on captured rows.
 */
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
  // biome-ignore lint/suspicious/noExplicitAny: drizzle Db shape
  const db: any = {
    // biome-ignore lint/suspicious/noExplicitAny: transaction wrapper
    transaction: async (fn: any) => fn(db),
    select: () => emptySelect,
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

/** Minimal ToolContext stub for unit-layer tool tests. */
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
