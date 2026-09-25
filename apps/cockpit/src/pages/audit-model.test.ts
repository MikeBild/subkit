import { describe, expect, test } from "bun:test";
import {
  actorTypeKey,
  auditActionKey,
  auditResourceHref,
  resourceTypeKey,
} from "@/pages/audit-model";

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
    expect(resourceTypeKey("credential")).toBe("permission.resource.credentials");
    expect(resourceTypeKey("setting")).toBe("nav.settings");
    expect(resourceTypeKey("webhook_inbound")).toBe("audit.resource.inboundWebhook");
    expect(resourceTypeKey("mcp_oauth_client")).toBe("audit.resource.oauthClient");
    expect(resourceTypeKey("mcp_oauth_code")).toBe("audit.resource.oauthCode");
    expect(resourceTypeKey("mcp_oauth_token")).toBe("audit.resource.oauthToken");
  });

  test("admits when a type is not one it knows", () => {
    expect(actorTypeKey("robot")).toBe("common.unknown");
    expect(resourceTypeKey("robot")).toBe("audit.resource.other");
    expect(auditActionKey("robot.started")).toBe("audit.action.other");
  });

  test("names production audit actions instead of exposing API enums", () => {
    expect(auditActionKey("settings.changed")).toBe("audit.action.settingsChanged");
    expect(auditActionKey("mcp_oauth.token_used")).toBe("audit.action.oauthTokenUsed");
    expect(auditActionKey("credential.oauth2_refreshed")).toBe("audit.action.credentialRefreshed");
    // A held schedule and a released one are one action; which of the two it
    // is, is the row's own denied/allowed. So one word covers both — and it
    // has to be a word, not the engine's string.
    expect(auditActionKey("schedule.admission.changed")).toBe(
      "audit.action.scheduleAdmissionChanged",
    );
  });
});
