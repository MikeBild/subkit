import { describe, expect, test } from "bun:test";
import { actorTypeKey, auditResourceHref, resourceTypeKey } from "@/pages/audit-model";

describe("audit resource relations", () => {
  test("routes a known resource type to its cockpit page", () => {
    expect(auditResourceHref("workflow", "018f4b4a-6d33-7b3a-9c2d-123456789abc")).toBe(
      "/cockpit/workflows/018f4b4a-6d33-7b3a-9c2d-123456789abc",
    );
    expect(auditResourceHref("knowledge_source", "abc")).toBe("/cockpit/knowledge/abc");
  });

  test("an unmapped resource type gets no link", () => {
    expect(auditResourceHref("tenant", "abc")).toBeNull();
  });

  test("a run has no detail route, so it stays a word", () => {
    expect(auditResourceHref("execution", "abc")).toBeNull();
  });

  test("a missing id gets no link even when the type is known", () => {
    expect(auditResourceHref("workflow", null)).toBeNull();
  });
});

describe("audit vocabulary", () => {
  test("names actor and resource types as words", () => {
    expect(actorTypeKey("system_account")).toBe("audit.actor.systemAccount");
    expect(resourceTypeKey("connector")).toBe("resource.connectors.title");
    expect(resourceTypeKey("notification_delivery")).toBe("nav.notifications");
    expect(resourceTypeKey("session")).toBe("audit.resource.session");
  });

  test("admits when a type is not one it knows", () => {
    expect(actorTypeKey("robot")).toBe("common.unknown");
    expect(resourceTypeKey("robot")).toBe("common.unknown");
  });
});
