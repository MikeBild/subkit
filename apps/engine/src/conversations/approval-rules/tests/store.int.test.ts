import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../../audit/types.ts";
import { auditLog, toolApprovalRules, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { getTestNow } from "../../../test-helpers/determinism/index.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import { describeBoundAction } from "../../instruction-cover/bound-action.ts";
import { contentHash } from "../scope.ts";
import {
  decideRule,
  findCoveringRule,
  listRules,
  markRuleUsed,
  noteApprovedAction,
} from "../store.ts";

let tdb: TestDb;
let tenant_id = "";
let other_tenant_id = "";
let anna = "";
let bob = "";

function send(to: string[]) {
  return describeBoundAction(
    "call_connector",
    { connector_id: "mail", method: "POST", path: "/v1/messages/send", body: { to } },
    to,
  );
}

async function person(tenant: string, label: string): Promise<string> {
  const [row] = await tdb.db
    .insert(users)
    .values({
      tenant_id: tenant,
      email: `${label}@example.test`,
      role_id: await builtinRoleId(tdb.db, "member"),
    })
    .returning({ id: users.id });
  if (!row) throw new Error("user fixture missing");
  return row.id;
}

beforeAll(async () => {
  tdb = await createTestDb("approval-rules-store");
  tenant_id = (await seedTenant(tdb.db, { slug: "rules-a" })).id;
  other_tenant_id = (await seedTenant(tdb.db, { slug: "rules-b" })).id;
  anna = await person(tenant_id, "anna");
  bob = await person(tenant_id, "bob");
}, 120_000);

afterAll(async () => {
  await tdb?.cleanup();
}, 30_000);

describe("standing approval rules", () => {
  test("repeated approvals offer a rule once and never create one", async () => {
    const owner = { tenant_id, user_id: anna };
    const action = send(["kunde@example.com"]);
    expect(await noteApprovedAction(tdb.db, owner, action)).toMatchObject({
      offered: false,
      state: "observed",
    });
    const second = await noteApprovedAction(tdb.db, owner, action);
    expect(second).toMatchObject({ offered: true, state: "offered" });
    for (let i = 0; i < 5; i++) {
      expect(await noteApprovedAction(tdb.db, owner, action)).toMatchObject({
        rule_id: second?.rule_id,
        offered: false,
        state: "offered",
      });
    }
    expect((await findCoveringRule(tdb.db, owner, action)).rule).toBeNull();
    const rows = await tdb.db
      .select()
      .from(toolApprovalRules)
      .where(and(eq(toolApprovalRules.tenant_id, tenant_id), eq(toolApprovalRules.user_id, anna)));
    expect(rows.map((row) => [row.state, row.approvals_count])).toEqual([["offered", 7]]);
  });

  test("only the person's explicit yes makes the rule active, with an audit entry", async () => {
    const owner = { tenant_id, user_id: anna };
    const [offered] = await listRules(tdb.db, owner, ["offered"]);
    if (!offered) throw new Error("offer missing");
    expect(await decideRule(tdb.db, { tenant_id, user_id: bob }, offered.id, "accept")).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(
      await decideRule(tdb.db, { tenant_id: other_tenant_id, user_id: anna }, offered.id, "accept"),
    ).toEqual({ ok: false, code: "not_found" });
    const accepted = await decideRule(tdb.db, owner, offered.id, "accept");
    expect(accepted).toMatchObject({ ok: true, rule: { state: "active" } });
    expect(await decideRule(tdb.db, owner, offered.id, "accept")).toEqual({
      ok: false,
      code: "wrong_state",
      state: "active",
    });
    const entries = await tdb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant_id),
          eq(auditLog.action, AuditAction.TOOL_APPROVAL_RULE_CREATED),
        ),
      );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor_id: anna,
      resource_type: "tool_approval_rule",
      resource_id: offered.id,
    });
  });

  test("an active rule covers exactly its tool, target, account and recipients", async () => {
    const owner = { tenant_id, user_id: anna };
    const covered = await findCoveringRule(tdb.db, owner, send(["kunde@example.com"]));
    expect(covered.rule?.state).toBe("active");
    expect(covered.rule?.expires_at?.getTime()).toBeGreaterThan(getTestNow() + 89 * 86_400_000);
    expect((await findCoveringRule(tdb.db, owner, send(["andere@example.com"]))).rule).toBeNull();
    expect(
      (await findCoveringRule(tdb.db, owner, send(["kunde@example.com", "chef@example.com"]))).rule,
    ).toBeNull();
    expect((await findCoveringRule(tdb.db, owner, send([]))).rule).toBeNull();
    expect(
      (
        await findCoveringRule(
          tdb.db,
          owner,
          describeBoundAction(
            "call_connector",
            {
              connector_id: "mail",
              method: "POST",
              path: "/v1/messages/forward",
              body: { to: ["kunde@example.com"] },
            },
            ["kunde@example.com"],
          ),
        )
      ).rule,
    ).toBeNull();
    expect(
      (
        await findCoveringRule(
          tdb.db,
          owner,
          describeBoundAction(
            "call_connector",
            {
              connector_id: "other-mail",
              method: "POST",
              path: "/v1/messages/send",
              body: { to: ["kunde@example.com"] },
            },
            ["kunde@example.com"],
          ),
        )
      ).rule,
    ).toBeNull();
    expect(
      (await findCoveringRule(tdb.db, { tenant_id, user_id: bob }, send(["kunde@example.com"])))
        .rule,
    ).toBeNull();
    if (covered.rule) expect(await markRuleUsed(tdb.db, tenant_id, covered.rule.id)).toBe(true);
    const [used] = await listRules(tdb.db, owner, ["active"]);
    expect(used?.use_count).toBe(1);
    expect(used?.last_used_at).toBeInstanceOf(Date);
  });

  test("the content class follows what was approved until the offer is made", async () => {
    const owner = { tenant_id, user_id: await person(tenant_id, "carla") };
    const classOf = async (rule_id: string) =>
      (await listRules(tdb.db, owner, ["observed", "offered", "active"])).find(
        (rule) => rule.id === rule_id,
      )?.content_class;
    const same = send(["gleich@example.com"]);
    const hash = contentHash(["Status", "Alles läuft."]);
    await noteApprovedAction(tdb.db, owner, same, hash);
    const sameOffer = await noteApprovedAction(tdb.db, owner, same, hash);
    if (!sameOffer) throw new Error("offer missing");
    expect(await classOf(sameOffer.rule_id)).toBe("same_content");
    await noteApprovedAction(tdb.db, owner, same, contentHash(["Etwas ganz anderes."]));
    expect(await classOf(sameOffer.rule_id)).toBe("same_content");

    const varied = send(["wechselnd@example.com"]);
    await noteApprovedAction(tdb.db, owner, varied, hash);
    const variedOffer = await noteApprovedAction(tdb.db, owner, varied, contentHash(["Neu."]));
    if (!variedOffer) throw new Error("offer missing");
    expect(await classOf(variedOffer.rule_id)).toBe("person_given");

    const bare = send(["ohne@example.com"]);
    await noteApprovedAction(tdb.db, owner, bare);
    const bareOffer = await noteApprovedAction(tdb.db, owner, bare);
    if (!bareOffer) throw new Error("offer missing");
    expect(await classOf(bareOffer.rule_id)).toBe("no_content");
    await decideRule(tdb.db, owner, bareOffer.rule_id, "accept");
    const withText = await findCoveringRule(tdb.db, owner, bare, { hash, given: true });
    expect(withText).toEqual({ rule: null, refusal: "rule_content" });
    expect((await findCoveringRule(tdb.db, owner, bare)).rule?.id).toBe(bareOffer.rule_id);
  });

  test("a deletion or a payment never becomes a rule", async () => {
    const owner = { tenant_id, user_id: bob };
    const deletion = describeBoundAction("call_connector", {
      connector_id: "desk",
      method: "DELETE",
      path: "/tickets/1",
    });
    const payment = describeBoundAction("call_connector", {
      connector_id: "billing",
      method: "POST",
      path: "/invoices/7/pay",
      body: {},
    });
    for (const action of [deletion, payment]) {
      expect(await noteApprovedAction(tdb.db, owner, action)).toBeNull();
      expect(await noteApprovedAction(tdb.db, owner, action)).toBeNull();
    }
    expect(await listRules(tdb.db, owner, ["observed", "offered", "active"])).toEqual([]);
  });

  test("a revoked rule stops covering and a declined offer is not offered again", async () => {
    const owner = { tenant_id, user_id: anna };
    const [active] = await listRules(tdb.db, owner, ["active"]);
    if (!active) throw new Error("active rule missing");
    expect(await decideRule(tdb.db, owner, active.id, "revoke")).toMatchObject({
      ok: true,
      rule: { state: "revoked" },
    });
    expect((await findCoveringRule(tdb.db, owner, send(["kunde@example.com"]))).rule).toBeNull();
    expect(await noteApprovedAction(tdb.db, owner, send(["kunde@example.com"]))).toMatchObject({
      offered: false,
      state: "revoked",
    });
    const second = send(["lieferant@example.com"]);
    await noteApprovedAction(tdb.db, owner, second);
    const offer = await noteApprovedAction(tdb.db, owner, second);
    if (!offer) throw new Error("offer missing");
    expect(await decideRule(tdb.db, owner, offer.rule_id, "dismiss")).toMatchObject({
      ok: true,
      rule: { state: "dismissed" },
    });
    expect(await noteApprovedAction(tdb.db, owner, second)).toMatchObject({
      offered: false,
      state: "dismissed",
    });
    expect((await findCoveringRule(tdb.db, owner, second)).rule).toBeNull();
  });
});
