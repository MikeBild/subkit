import type { ConversationAccessRow, ConversationViewer } from "./access.ts";

export interface AccessCase {
  readonly name: string;
  readonly viewer: ConversationViewer;
  readonly row: ConversationAccessRow;
  readonly read: boolean;
  readonly write: boolean;
  readonly delete: boolean;
}

export const OWNER: ConversationViewer = {
  id: "00000000-0000-4000-8000-000000000001",
  tenant_id: "t1",
  is_admin: false,
};
export const MATE: ConversationViewer = {
  id: "00000000-0000-4000-8000-000000000002",
  tenant_id: "t1",
  is_admin: false,
};
export const ADMIN: ConversationViewer = {
  id: "00000000-0000-4000-8000-000000000003",
  tenant_id: "t1",
  is_admin: true,
};
export const OTHER_TENANT: ConversationViewer = {
  id: "00000000-0000-4000-8000-000000000004",
  tenant_id: "t2",
  is_admin: false,
};

function row(
  visibility: ConversationAccessRow["visibility"],
  owner_id: string | null,
  task_run: ConversationAccessRow["task_run"] = null,
): ConversationAccessRow {
  return { tenant_id: "t1", owner_id, visibility, task_run };
}

export const ACCESS_ROWS = {
  private: row("private", OWNER.id),
  team: row("team", OWNER.id),
  unownedPrivate: row("private", null),
  unownedTeam: row("team", null),
  taskRun: row("private", OWNER.id, { sealed: false }),
  sealedTaskRun: row("private", OWNER.id, { sealed: true }),
} as const;

export type AccessRowKind = keyof typeof ACCESS_ROWS;

type Expect = readonly [read: boolean, write: boolean, del: boolean];

const TABLE: Record<AccessRowKind, Record<"owner" | "mate" | "admin", Expect>> = {
  private: { owner: [true, true, true], mate: [false, false, false], admin: [false, false, true] },
  team: { owner: [true, true, true], mate: [true, false, false], admin: [true, false, true] },
  unownedPrivate: {
    owner: [false, false, false],
    mate: [false, false, false],
    admin: [true, true, true],
  },
  unownedTeam: {
    owner: [true, false, false],
    mate: [true, false, false],
    admin: [true, true, true],
  },
  taskRun: { owner: [true, true, true], mate: [false, false, false], admin: [true, true, true] },
  sealedTaskRun: {
    owner: [false, true, true],
    mate: [false, false, false],
    admin: [true, true, true],
  },
};

export const ACCESS_VIEWERS = { owner: OWNER, mate: MATE, admin: ADMIN } as const;

/** One case per row kind and viewer; shared by the unit test and the SQL parity test. */
export const ACCESS_CASES: readonly (AccessCase & { readonly kind: AccessRowKind })[] =
  Object.entries(TABLE).flatMap(([kind, byViewer]) =>
    Object.entries(byViewer).map(([who, [read, write, del]]) => ({
      name: `${who} on ${kind}: read=${read} write=${write} delete=${del}`,
      kind: kind as AccessRowKind,
      viewer: ACCESS_VIEWERS[who as keyof typeof ACCESS_VIEWERS],
      row: ACCESS_ROWS[kind as AccessRowKind],
      read,
      write,
      delete: del,
    })),
  );
