import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  actorTypeKey,
  auditActionLabel,
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
    // The machine value itself, marked as one — not a word claiming the log
    // recorded something indistinct.
    expect(auditActionLabel("robot.started")).toEqual({
      kind: "machine",
      value: "robot.started",
    });
  });

  test("names production audit actions instead of exposing API enums", () => {
    expect(auditActionLabel("settings.changed")).toEqual({
      kind: "named",
      key: "audit.action.settingsChanged",
    });
    expect(auditActionLabel("mcp_oauth.token_used")).toEqual({
      kind: "named",
      key: "audit.action.oauthTokenUsed",
    });
    expect(auditActionLabel("credential.oauth2_refreshed")).toEqual({
      kind: "named",
      key: "audit.action.credentialRefreshed",
    });
    // A held schedule and a released one are one action; which of the two it
    // is, is the row's own denied/allowed. So one word covers both — and it
    // has to be a word, not the engine's string.
    expect(auditActionLabel("schedule.admission.changed")).toEqual({
      kind: "named",
      key: "audit.action.scheduleAdmissionChanged",
    });
  });
});

describe("the decision trail is named", () => {
  // The log exists so a human decision can be traced. These verbs ARE that
  // trail, and every one of them read "Weiterer Vorgang" — a phrase that
  // claims the log recorded something indistinct, about the rows that matter
  // most. §15.2 forbids exactly that reading.
  const MUST_BE_NAMED = [
    "approval.requested",
    "approval.granted",
    "approval.rejected",
    "approval.dispatch_denied",
    "workflow.authority_granted",
    "workflow.authority_revoked",
    "policy.denied",
    "rbac.permission_granted",
    "rbac.permission_revoked",
    "rbac.user_role_assigned",
    "user.deleted",
    "api_key.revoked",
    "schedule.deleted",
    "workflow.deleted",
    "secret.version_revoked",
    "external_write",
  ];

  test("every verb a person answers for has a name", () => {
    const unnamed = MUST_BE_NAMED.filter((action) => auditActionLabel(action).kind !== "named");
    expect(unnamed, `these read as machine values: ${unnamed.join(", ")}`).toEqual([]);
  });

  test("an unnamed verb is the engine's token, marked as one", () => {
    // Not prose. A reader must be able to tell "this has no name yet" from
    // "the log recorded something vague".
    expect(auditActionLabel("some.future.verb")).toEqual({
      kind: "machine",
      value: "some.future.verb",
    });
  });

  test("both languages name every verb this build claims to name", () => {
    // A key in the map with no German is an English word on a German screen.
    for (const action of MUST_BE_NAMED) {
      const label = auditActionLabel(action);
      if (label.kind !== "named") continue;
      for (const locale of ["en", "de"] as const) {
        const text = translate(locale, label.key);
        expect(text, `${action} has no ${locale} text`).not.toBe(label.key);
        expect(text.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
