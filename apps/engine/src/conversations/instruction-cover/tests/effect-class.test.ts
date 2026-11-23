import { describe, expect, test } from "bun:test";
import { describeBoundAction } from "../bound-action.ts";
import { isNeverCovered } from "../core/never-covered.ts";
import { declaredEffect } from "../declared-effect.ts";

function effect(method: string, path: string, body: unknown = {}, template?: string) {
  return describeBoundAction(
    "call_connector",
    { connector_id: "c", method, path, body },
    [],
    template ? { template } : {},
  ).effect_class;
}

describe("effect class of a connector call", () => {
  test("operations nobody recognises are unknown and never run without asking", () => {
    for (const path of ["/v2/dispatchBatch/execute", "/api/x9/vorgaenge", "/rpc", "/", "/zap"]) {
      expect(effect("POST", path)).toBe("unknown");
      expect(isNeverCovered(describeBoundAction("call_connector", { method: "POST", path }))).toBe(
        true,
      );
    }
    expect(effect("PATCH", "/widgets/5")).toBe("unknown");
    expect(effect("PUT", "/gizmos/5")).toBe("unknown");
  });

  test("familiar operations stay ordinary", () => {
    for (const path of [
      "/v1/messages/send",
      "/api/chat.postMessage",
      "/rest/api/3/issue",
      "/calendar/events",
      "/tickets/4711/comments",
      "/time_entries",
      "/v1/drafts",
    ]) {
      expect(effect("POST", path)).toBe("ordinary");
    }
    expect(effect("PATCH", "/tasks/88")).toBe("ordinary");
  });

  test("unusual names for deletion, payment, publication and admin are caught", () => {
    const cases: Array<[string, string, unknown, string]> = [
      ["POST", "/tickets/5/expunge", {}, "deletion"],
      ["POST", "/messages/5/discard", {}, "deletion"],
      ["POST", "/v1/issues/obliterate", {}, "deletion"],
      ["PATCH", "/contacts/77", { state: "terminated" }, "deletion"],
      ["PATCH", "/tickets/7", { status: "archived" }, "deletion"],
      ["POST", "/records", { action: "PurgeRecords" }, "deletion"],
      ["POST", "/tasks", { operation: "bulk_delete" }, "deletion"],
      ["POST", "/v1/disbursements", {}, "payment"],
      ["POST", "/v1/wires/entries", {}, "payment"],
      ["POST", "/invoices/9/capture", {}, "payment"],
      ["POST", "/tasks", { type: "payout" }, "payment"],
      ["POST", "/v1/announcements", {}, "publication"],
      ["POST", "/pages/3/goLive", {}, "publication"],
      ["POST", "/messages", { audience: "everyone" }, "publication"],
      ["PATCH", "/admin/tickets/4", {}, "permission_or_settings"],
      ["POST", "/tickets/4/transferOwnership", {}, "payment"],
      ["POST", "/items/4/impersonate", {}, "permission_or_settings"],
      ["POST", "/messages", { role: "owner" }, "permission_or_settings"],
      ["POST", "/notes/apiKeys", {}, "credential"],
      ["POST", "/v1/signup", {}, "account_creation"],
    ];
    for (const [method, path, body, expected] of cases) {
      expect(`${path} ${effect(method, path, body)}`).toBe(`${path} ${expected}`);
    }
    expect(effect("DELETE", "/notes/1")).toBe("deletion");
  });

  test("a connector template declares what its operations do", () => {
    expect(declaredEffect("stripe", "POST", "/refunds")).toBe("payment");
    expect(declaredEffect("stripe", "POST", "/customers")).toBe("ordinary");
    expect(declaredEffect("stripe", "POST", "/anything_else")).toBe("payment");
    expect(declaredEffect("mailchimp", "POST", "/campaigns/c1/actions/send")).toBe("publication");
    expect(declaredEffect("linkedin", "POST", "/v2/ugcPosts")).toBe("publication");
    expect(declaredEffect("aws-sqs", "POST", "/")).toBe("unknown");
    expect(declaredEffect("slack", "POST", "/reactions.add")).toBe("ordinary");
    expect(declaredEffect("slack", "POST", "/never.heard")).toBeNull();
    expect(declaredEffect("no-such-template", "POST", "/x")).toBeNull();
    expect(declaredEffect(null, "POST", "/x")).toBeNull();
    expect(effect("POST", "/customers", {}, "stripe")).toBe("ordinary");
    expect(effect("POST", "/customers")).toBe("unknown");
    expect(effect("POST", "/unusual_notes", {}, "stripe")).toBe("payment");
    expect(effect("POST", "/v2/ugcPosts", {}, "linkedin")).toBe("publication");
  });

  test("authorization-like headers make the call a credential matter", () => {
    for (const name of ["Authorization", "authorization", "Cookie", "X-Api-Key", "X-Auth-Token"]) {
      expect(
        describeBoundAction("call_connector", {
          method: "POST",
          path: "/v1/messages/send",
          headers: { [name]: "x" },
        }).effect_class,
      ).toBe("credential");
    }
  });

  test("a draft is marked as such", () => {
    expect(
      describeBoundAction("call_connector", { method: "POST", path: "/v1/drafts" }).draft,
    ).toBe(true);
    expect(
      describeBoundAction("call_connector", { method: "POST", path: "/v1/messages/send" }).draft,
    ).toBe(false);
  });
});
