import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { systemAccounts, users } from "../../db/schema/index.ts";
import { can } from "../evaluator.ts";
import { buildQueryPrincipal } from "../query-principal.ts";
import {
  AT,
  addSystemAccount,
  addTenant,
  addUser,
  builtinRole,
  customRole,
  useAccessDb,
} from "./workflow-start-access-fixtures.ts";

const h = useAccessDb("query_principal", 20_261_107);

let tenantA: string;
let tenantB: string;
let memberA: string;
let customA: string;
let botA: string;
let roleLessBotA: string;
let deletedUserA: string;
let deletedBotA: string;

beforeAll(async () => {
  tenantA = await addTenant(h, "qp-a");
  tenantB = await addTenant(h, "qp-b");
  const member = await builtinRole(h, "member");
  const reviewer = await customRole(h, tenantA, "reviewer", ["workflow:read"]);
  memberA = await addUser(h, tenantA, "member@qp", member);
  customA = await addUser(h, tenantA, "custom@qp", reviewer);
  botA = await addSystemAccount(h, tenantA, "bot", reviewer);
  roleLessBotA = await addSystemAccount(h, tenantA, "roleless", null);
  deletedUserA = await addUser(h, tenantA, "gone@qp", member);
  await h.db.update(users).set({ deleted_at: AT }).where(eq(users.id, deletedUserA));
  deletedBotA = await addSystemAccount(h, tenantA, "gone-bot", member);
  await h.db
    .update(systemAccounts)
    .set({ deleted_at: AT })
    .where(eq(systemAccounts.id, deletedBotA));
});

describe("buildQueryPrincipal", () => {
  test("a user resolves to its role name in its own tenant", async () => {
    expect(await buildQueryPrincipal(h.db, tenantA, customA)).toEqual({
      provider: "rbac_query",
      kind: "user",
      id: customA,
      tenant_id: tenantA,
      roles: ["reviewer"],
    });
  });

  test("a system account resolves to its role name", async () => {
    expect(await buildQueryPrincipal(h.db, tenantA, botA)).toEqual({
      provider: "rbac_query",
      kind: "system_account",
      id: botA,
      tenant_id: tenantA,
      roles: ["reviewer"],
    });
  });

  test("a system account without a role resolves as member", async () => {
    expect((await buildQueryPrincipal(h.db, tenantA, roleLessBotA))?.roles).toEqual(["member"]);
  });

  test("a user whose role no longer exists resolves with no roles and holds nothing", async () => {
    const orphan = await addUser(h, tenantA, "orphan@qp", h.nextId());
    const principal = await buildQueryPrincipal(h.db, tenantA, orphan);
    expect(principal?.roles).toEqual([]);
    if (!principal) throw new Error("principal missing");
    const decision = await can(h.db, {
      tenant_id: tenantA,
      principal,
      permission: "workflow:read",
      quiet: true,
    });
    expect(decision.allow).toBe(false);
  });

  test("an unknown id resolves to nothing", async () => {
    expect(await buildQueryPrincipal(h.db, tenantA, h.nextId())).toBeNull();
  });

  test("a user or system account of another tenant resolves to nothing", async () => {
    expect(await buildQueryPrincipal(h.db, tenantB, memberA)).toBeNull();
    expect(await buildQueryPrincipal(h.db, tenantB, botA)).toBeNull();
  });

  test("a deleted user or system account resolves to nothing", async () => {
    expect(await buildQueryPrincipal(h.db, tenantA, deletedUserA)).toBeNull();
    expect(await buildQueryPrincipal(h.db, tenantA, deletedBotA)).toBeNull();
  });

  test("the resolved principal holds exactly its role's permissions", async () => {
    const principal = await buildQueryPrincipal(h.db, tenantA, customA);
    if (!principal) throw new Error("principal missing");
    const read = await can(h.db, { tenant_id: tenantA, principal, permission: "workflow:read" });
    const run = await can(h.db, {
      tenant_id: tenantA,
      principal,
      permission: "workflow:run",
      quiet: true,
    });
    expect(read).toEqual({ allow: true, source: "role" });
    expect(run.allow).toBe(false);
    expect(run.reason).toBe("permission_denied:workflow:run");
  });
});
