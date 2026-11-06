import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { listConnections } from "../credentials/connections/index.ts";
import { webhooksInbound } from "../db/schema/index.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { adminPrincipal } from "../test-helpers/principals.ts";
import { type AttentionItem, buildAttention, compareAttentionItems } from "./attention.ts";
import {
  brokenConnectorId,
  connectionId,
  enduser,
  grantee,
  HOUR,
  otherPerson,
  othersConversationId,
  ownConversationId,
  owner,
  tenant_id,
  testDb,
  unusedConnectionId,
  useAttentionTenant,
  wf,
} from "./attention-fixtures.ts";

useAttentionTenant();

const byId = (items: AttentionItem[]) => new Map(items.map((item) => [item.id, item]));

describe("every source, as an admin reads it", () => {
  test("each source yields its item in its class", async () => {
    const attention = await buildAttention(testDb.db, owner);
    const items = byId(attention.items);
    const classOf = (id: string) => items.get(id)?.class;

    expect(classOf(`conversation:${ownConversationId}`)).toBe("stopped");
    expect(classOf(`workflow:${wf.held}`)).toBe("stopped");
    expect(classOf("freshness:self_healing.drift_scan")).toBe("stopped");
    expect(classOf(`workflow:${wf.fail}`)).toBe("failing");
    expect(classOf(`workflow:${wf.auth}`)).toBe("failing");
    expect(classOf(`workflow:${wf.chat}`)).toBe("failing");
    expect(classOf(`connector:${brokenConnectorId}`)).toBe("failing");
    expect(classOf(`connection:${connectionId}`)).toBe("failing");
    expect(classOf("budget")).toBe("failing");
    expect(classOf(`workflow:${wf.patch}`)).toBe("decide");
    expect(classOf("secret-approval:settings.llm.api_key@2")).toBe("decide");
    expect(classOf("skills")).toBe("decide");
    expect(items.get("skills")?.counts.skills).toBe(1);
    expect(items.get(`connection:${connectionId}`)?.reason).toBe("secret_unreadable");
    expect(items.get(`connection:${connectionId}`)?.severity).toBe("urgent");
    const spare = (await listConnections(testDb.db, tenant_id)).find(
      (view) => view.id === unusedConnectionId,
    );
    expect(spare).toMatchObject({ state: "expired", state_reason: "expired_no_refresh" });
    expect(spare?.used_by).toEqual([]);
    expect(items.has(`connection:${unusedConnectionId}`)).toBe(false);
    expect(items.get(`connector:${brokenConnectorId}`)?.actions[0]?.verb).toBe("reauth");
    expect(items.get(`workflow:${wf.held}`)?.reason).toBe("execution_authority_required");
    expect(Object.values(attention.sources).every((state) => state === "answered")).toBe(true);
    expect(attention.status?.next_run_at).toBeNull();
  });

  test("one item per workflow: failures and open fixes merge, ids are unique", async () => {
    const attention = await buildAttention(testDb.db, owner);
    const ids = attention.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const failing = byId(attention.items).get(`workflow:${wf.fail}`);
    expect(failing?.counts).toEqual({ failures: 2, consecutive_failures: 2, patches: 1 });
    expect(failing?.cause_class).toBe("driver_error");
  });

  test("the primary action follows the remedy order", async () => {
    const items = byId((await buildAttention(testDb.db, owner)).items);
    const primary = (id: string) => items.get(id)?.actions.find((a) => a.primary);
    expect(primary(`workflow:${wf.fail}`)).toMatchObject({
      verb: "review",
      href: `/cockpit?review=workflow:${wf.fail}`,
    });
    expect(primary(`workflow:${wf.held}`)).toMatchObject({
      verb: "open",
      href: `/cockpit/workflows/${wf.held}#workflow-automation`,
    });
    expect(primary(`workflow:${wf.auth}`)).toMatchObject({
      verb: "reauth",
      href: `/cockpit/connectors/${brokenConnectorId}`,
    });
    const chat = primary(`workflow:${wf.chat}`);
    expect(chat?.verb).toBe("chat");
    expect(chat?.href).toStartWith(`/cockpit/chat/new?workflow_id=${wf.chat}&execution_id=`);
    expect(items.get(`workflow:${wf.chat}`)?.actions.find((a) => !a.primary)).toMatchObject({
      verb: "open_runs",
      href: `/cockpit?runs=all&runs_workflow=${wf.chat}&runs_status=failed`,
    });
    expect(primary(`conversation:${ownConversationId}`)).toMatchObject({
      verb: "answer",
      href: `/cockpit/chat/${ownConversationId}`,
    });
    expect(primary(`connection:${connectionId}`)?.href).toBe(
      `/cockpit/connectors/${brokenConnectorId}`,
    );
  });

  test("ordering: stopped → failing → decide, then nearest deadline, then oldest", async () => {
    const { items } = await buildAttention(testDb.db, owner);
    expect([...items].sort(compareAttentionItems)).toEqual(items);
    const classes = items.map((item) => item.class);
    expect(classes).toEqual([...classes].sort((a, b) => rank(a) - rank(b)));
    expect(items[0]?.id).toBe(`conversation:${ownConversationId}`);
    expect(items[1]?.id).toBe("freshness:self_healing.drift_scan");
    expect(items[2]?.id).toBe(`workflow:${wf.held}`);
  });
});

function rank(klass: AttentionItem["class"]): number {
  return { stopped: 0, failing: 1, decide: 2 }[klass];
}

describe("per reader", () => {
  test("a person sees only their own waiting conversations — admins included", async () => {
    const mine = (await buildAttention(testDb.db, owner)).items.map((i) => i.id);
    expect(mine).toContain(`conversation:${ownConversationId}`);
    expect(mine).not.toContain(`conversation:${othersConversationId}`);
    const theirs = (await buildAttention(testDb.db, otherPerson)).items.map((i) => i.id);
    expect(theirs).toContain(`conversation:${othersConversationId}`);
    expect(theirs).not.toContain(`conversation:${ownConversationId}`);
  });

  test("a non-admin sees what its role reads; the rest is not_permitted, never empty", async () => {
    const attention = await buildAttention(testDb.db, enduser);
    const ids = attention.items.map((i) => i.id);
    expect(ids).toContain(`workflow:${wf.fail}`);
    expect(ids).toContain("skills");
    expect(ids).not.toContain(`connector:${brokenConnectorId}`);
    expect(ids).not.toContain("budget");
    expect(attention.sources.connectors).toBe("not_permitted");
    expect(attention.sources.connections).toBe("not_permitted");
    expect(attention.sources.secret_approvals).toBe("not_permitted");
    expect(attention.sources.freshness).toBe("not_permitted");
    expect(attention.sources.failures).toBe("answered");
    expect(attention.status).toBeNull();
  });

  test("a resource grant on one workflow shows that workflow's item and nothing else", async () => {
    const attention = await buildAttention(testDb.db, grantee);
    expect(attention.items.map((i) => i.id)).toEqual([`workflow:${wf.auth}`]);
    expect(attention.sources.failures).toBe("answered");
    expect(attention.sources.connectors).toBe("not_permitted");
    expect(attention.sources.conversations).toBe("not_permitted");
  });

  test("a key whose scopes exclude the permission reads nothing, grant or not", async () => {
    const scoped: ResolvedPrincipal = { ...grantee, scopes: ["execution:read"] };
    const attention = await buildAttention(testDb.db, scoped);
    expect(attention.items).toEqual([]);
    expect(attention.sources.failures).toBe("not_permitted");
    expect(attention.sources.patches).toBe("not_permitted");
  });

  test("without the grant the same reader is refused the source, not told it is empty", async () => {
    const stranger: ResolvedPrincipal = { ...grantee, id: "00000000-0000-4000-8000-00000000beef" };
    const attention = await buildAttention(testDb.db, stranger);
    expect(attention.items).toEqual([]);
    expect(attention.sources.failures).toBe("not_permitted");
  });
});

describe("a held webhook", () => {
  test("names its hook only to a reader who may read hooks", async () => {
    const [hook] = await testDb.db
      .insert(webhooksInbound)
      .values({
        tenant_id,
        slug: "findings-intake",
        workflow_id: wf.auth,
        verifier: "standard_webhooks",
        secret_ciphertext: Buffer.from("c"),
        secret_iv: Buffer.from("i"),
        secret_auth_tag: Buffer.from("t"),
        admission_hold: {
          reason_code: "execution_authority_required",
          observed_at: new Date(getTestNow() - HOUR).toISOString(),
        },
      })
      .returning();
    try {
      const asAdmin = await buildAttention(testDb.db, adminPrincipal(tenant_id));
      const adminItem = asAdmin.items.find((i) => i.id === `workflow:${wf.auth}`);
      expect(adminItem?.trigger).toEqual({ kind: "inbound_hook", name: "findings-intake" });
      const asGrantee = await buildAttention(testDb.db, grantee);
      const granteeItem = asGrantee.items.find((i) => i.id === `workflow:${wf.auth}`);
      expect(granteeItem?.trigger).toEqual({ kind: "inbound_hook", name: null });
    } finally {
      await testDb.db.delete(webhooksInbound).where(eq(webhooksInbound.id, hook!.id));
    }
  });
});
