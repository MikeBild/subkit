import { describe, expect, test } from "bun:test";
import { AttentionV1Schema } from "../http/routes/operator/attention-schema.ts";
import { ATTENTION_SOURCES } from "./core/attention.ts";
import {
  isOwnPairRequest,
  type PendingPairRequest,
  pairAttentionFor,
} from "./pair-approval-attention.ts";

const request: PendingPairRequest = {
  id: "11111111-1111-4111-8111-111111111111",
  workflow_id: "22222222-2222-4222-8222-222222222222",
  workflow_name: "Rechnungen ablegen",
  execution_environment: "prod",
  first_approver_id: "anna",
  created_at: new Date("2026-11-21T10:00:00.000Z"),
  expires_at: new Date("2026-11-24T10:00:00.000Z"),
};
const bert = { user_id: "bert", name: "Bert" };

describe("pair approvals in the attention list", () => {
  test("a second person who may approve sees the request with a review action", () => {
    const [item] = pairAttentionFor("bert", [request], () => true, null);
    expect(item).toMatchObject({
      id: `pair:${request.id}`,
      class: "decide",
      reason: "pair_approval_requested",
      subject: { kind: "workflow", id: request.workflow_id, environment: "prod" },
      deadline: "2026-11-24T10:00:00.000Z",
      actions: [{ verb: "review", primary: true, permission: "workflow:write" }],
    });
    expect(item?.waiting_on).toBeUndefined();
    expect(item && isOwnPairRequest(item)).toBe(false);
    const sources = Object.fromEntries(ATTENTION_SOURCES.map((source) => [source, "answered"]));
    const parsed = AttentionV1Schema.parse({
      schema_version: "attention.v1",
      generated_at: "2026-11-21T10:00:00.000Z",
      sources,
      status: null,
      items: [item],
      snoozed: [],
    });
    expect(parsed.items[0]?.reason).toBe("pair_approval_requested");
  });

  test("someone without the permission does not see it", () => {
    expect(pairAttentionFor("cora", [request], () => false, null)).toEqual([]);
  });

  test("the person who asked sees it waiting on the named partner", () => {
    const [item] = pairAttentionFor("anna", [request], () => true, bert);
    expect(item?.waiting_on).toEqual(bert);
    expect(item && isOwnPairRequest(item)).toBe(true);
    expect(item?.severity).toBe("notice");
    expect(pairAttentionFor("anna", [request], () => true, null)[0]?.waiting_on).toBeUndefined();
  });
});
