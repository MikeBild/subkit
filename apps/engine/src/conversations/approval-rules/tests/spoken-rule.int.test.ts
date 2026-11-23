import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { toolApprovalRules, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import { describeBoundAction } from "../../instruction-cover/bound-action.ts";
import type { ToolContext } from "../../tools/index.ts";
import { proposeApprovalRuleTool } from "../spoken-rule-tool.ts";
import { decideRule, findCoveringRule, offerSpokenRule } from "../store.ts";

let tdb: TestDb;
let tenant_id = "";
let anna = "";

const JANE = "jane@example.test";
const SPOKEN = `From now on you can send the weekly report to ${JANE} without asking.`;

function sendArgs(to: string[]) {
  return { connector_id: "mail", method: "POST", path: "/v1/messages/send", body: { to } };
}

function send(to: string[]) {
  return describeBoundAction("call_connector", sendArgs(to), to);
}

async function rulesOf(user_id: string) {
  return tdb.db
    .select()
    .from(toolApprovalRules)
    .where(and(eq(toolApprovalRules.tenant_id, tenant_id), eq(toolApprovalRules.user_id, user_id)));
}

function context(over: Partial<ToolContext>): ToolContext {
  const principal: ResolvedPrincipal = {
    provider: "test",
    kind: "user",
    id: anna,
    tenant_id,
    roles: ["member"],
  };
  return {
    db: tdb.db,
    tenant_id,
    conversation_id: "11111111-2222-4333-8444-555555555555",
    actor_id: anna,
    principal,
    recentUserMessage: SPOKEN,
    ...over,
  } as ToolContext;
}

beforeAll(async () => {
  tdb = await createTestDb("approval-rules-spoken");
  tenant_id = (await seedTenant(tdb.db, { slug: "rules-spoken" })).id;
  const [row] = await tdb.db
    .insert(users)
    .values({
      tenant_id,
      email: "anna-spoken@example.test",
      role_id: await builtinRoleId(tdb.db, "member"),
    })
    .returning({ id: users.id });
  if (!row) throw new Error("user fixture missing");
  anna = row.id;
}, 120_000);

afterAll(async () => {
  await tdb?.cleanup();
}, 30_000);

describe("a rule stated in chat", () => {
  test("is stored as an offer with the person's words and covers nothing yet", async () => {
    const owner = { tenant_id, user_id: anna };
    const action = send([JANE]);
    const offered = await offerSpokenRule(tdb.db, owner, action, SPOKEN);
    expect(offered).toMatchObject({ offered: true, state: "offered" });
    const rows = await rulesOf(anna);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "offered", source_quote: SPOKEN, expires_at: null });
    expect(rows[0]?.offered_at).not.toBeNull();
    expect((await findCoveringRule(tdb.db, owner, action)).rule).toBeNull();
  });

  test("stating it again keeps one offer and never makes it active", async () => {
    const owner = { tenant_id, user_id: anna };
    const again = await offerSpokenRule(tdb.db, owner, send([JANE]), `Always send it to ${JANE}.`);
    expect(again).toMatchObject({ offered: true, state: "offered" });
    const rows = await rulesOf(anna);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source_quote).toBe(`Always send it to ${JANE}.`);
  });

  test("after the person's yes the rule keeps its words, and a new statement changes nothing", async () => {
    const owner = { tenant_id, user_id: anna };
    const [offer] = await rulesOf(anna);
    if (!offer) throw new Error("offer missing");
    expect(await decideRule(tdb.db, owner, offer.id, "accept")).toMatchObject({
      ok: true,
      rule: { state: "active", source_quote: `Always send it to ${JANE}.` },
    });
    expect(await offerSpokenRule(tdb.db, owner, send([JANE]), SPOKEN)).toMatchObject({
      offered: false,
      state: "active",
    });
    expect((await rulesOf(anna))[0]?.source_quote).toBe(`Always send it to ${JANE}.`);
    expect((await findCoveringRule(tdb.db, owner, send([JANE]))).rule?.id).toBe(offer.id);
  });

  test("a revoked rule can be offered again and stays without effect until accepted", async () => {
    const owner = { tenant_id, user_id: anna };
    const [active] = await rulesOf(anna);
    if (!active) throw new Error("rule missing");
    await decideRule(tdb.db, owner, active.id, "revoke");
    expect(await offerSpokenRule(tdb.db, owner, send([JANE]), SPOKEN)).toMatchObject({
      offered: true,
      state: "offered",
    });
    const [row] = await rulesOf(anna);
    expect(row).toMatchObject({ state: "offered", revoked_at: null, source_quote: SPOKEN });
    expect((await findCoveringRule(tdb.db, owner, send([JANE]))).rule).toBeNull();
  });
});

describe("the tool that offers a stated rule", () => {
  const call = (ctx: ToolContext, quote: string, to: string[]) =>
    proposeApprovalRuleTool.execute(ctx, { quote, tool: "call_connector", args: sendArgs(to) });

  test("offers the rule from the person's own words", async () => {
    const result = await call(context({}), SPOKEN, [JANE]);
    expect(result).toMatchObject({ ok: true, data: { state: "offered" } });
  });

  test("refuses words the person did not write", async () => {
    const result = await call(
      context({ recentUserMessage: "Send the report to jane today." }),
      SPOKEN,
      [JANE],
    );
    expect(result).toMatchObject({ ok: false, error_code: "quote_not_in_user_words" });
  });

  test("refuses a single request and a recipient the person did not name", async () => {
    const once = `Please send the weekly report to ${JANE} today.`;
    expect(await call(context({ recentUserMessage: once }), once, [JANE])).toMatchObject({
      ok: false,
      error_code: "not_a_standing_rule",
    });
    expect(await call(context({}), SPOKEN, [JANE, "eve@example.test"])).toMatchObject({
      ok: false,
      error_code: "not_a_standing_rule",
    });
  });

  test("refuses when no person is in the conversation", async () => {
    expect(await call(context({ principal: null }), SPOKEN, [JANE])).toMatchObject({
      ok: false,
      error_code: "person_required",
    });
    expect(
      await call(
        context({
          task_run: {
            task_id: "11111111-2222-4333-8444-555555555555",
            task_run_id: "55555555-6666-4777-8888-999999999999",
          } as NonNullable<ToolContext["task_run"]>,
        }),
        SPOKEN,
        [JANE],
      ),
    ).toMatchObject({ ok: false, error_code: "person_required" });
  });

  test("refuses a tool that always asks", async () => {
    expect(
      await proposeApprovalRuleTool.execute(context({}), {
        quote: SPOKEN,
        tool: "delete_workflow",
        args: {},
      }),
    ).toMatchObject({ ok: false, error_code: "tool_not_coverable" });
  });
});
