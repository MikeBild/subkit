import { describe, expect, test } from "bun:test";
import { ALL_ROUTE_PATHS } from "@/app/route-table";
import { type Locale, type TranslationKey, translate } from "@/lib/i18n";
import {
  actorTypeLabel,
  auditActionLabel,
  auditDetailFacts,
  auditEvidenceBlocks,
  auditResourceHref,
  auditResourceLabel,
  auditResultLabel,
  auditScopeParams,
  auditTraceFromUrl,
  isAuditEntry,
  isAuditScope,
  LINKED_RESOURCE_TYPES,
  normalizedAuditScope,
} from "@/pages/audit-model";
import { type AuditEntry, deText, ENTRY, entry } from "./audit-model-fixtures.ts";

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

  test("a run leads to the run it names", () => {
    expect(auditResourceHref("execution", "018f4b4a-6d33-7b3a-9c2d-123456789abc")).toBe(
      "/cockpit?run=018f4b4a-6d33-7b3a-9c2d-123456789abc",
    );
  });

  test("a missing id gets no link even when the type is known", () => {
    expect(auditResourceHref("workflow", null)).toBeNull();
  });

  test("every type that gets a link lands on a route this cockpit registers", () => {
    const detailPrefixes = new Set(
      ALL_ROUTE_PATHS.filter((path) => /\/\$[A-Za-z]+$/.test(path)).map((path) =>
        path.replace(/\/\$[A-Za-z]+$/, ""),
      ),
    );
    for (const type of LINKED_RESOURCE_TYPES) {
      if (type.startsWith("task")) continue;
      const href = auditResourceHref(type, "018f4b4a-6d33-7b3a-9c2d-123456789abc");
      expect(href, `${type} is mapped but builds no link`).not.toBeNull();
      if (href?.startsWith("/cockpit?run=")) continue;
      const prefix = (href ?? "").replace(/^\/cockpit/, "").replace(/\/[^/]+$/, "");
      expect(detailPrefixes.has(prefix), `${type} points at ${href}, which no route matches`).toBe(
        true,
      );
    }
  });

  test("a type with only a list page stays a word, not a guessed path", () => {
    for (const type of [
      "user",
      "role",
      "api_key",
      "credential",
      "session",
      "setting",
      "tenant",
      "schedule",
      "notification_delivery",
      "mcp_oauth_token",
      "patch_candidate",
      "skill_candidate",
    ]) {
      expect(
        auditResourceHref(type, "018f4b4a-6d33-7b3a-9c2d-123456789abc"),
        `${type} guessed a path`,
      ).toBeNull();
    }
  });
});

describe("audit vocabulary", () => {
  test("names actor and resource types as words", () => {
    expect(actorTypeLabel("system_account", deText)).toEqual({
      text: deText("audit.actor.systemAccount"),
      machine: false,
    });
    const named: Array<[string, TranslationKey]> = [
      ["connector", "resource.connectors.title"],
      ["notification_delivery", "nav.notifications"],
      ["session", "audit.resource.session"],
      ["credential", "permission.resource.credentials"],
      ["setting", "nav.settings"],
      ["webhook_inbound", "audit.resource.inboundWebhook"],
      ["mcp_oauth_client", "audit.resource.oauthClient"],
      ["mcp_oauth_code", "audit.resource.oauthCode"],
      ["mcp_oauth_token", "audit.resource.oauthToken"],
      ["connection", "permission.resource.connections"],
    ];
    for (const [type, key] of named)
      expect(auditResourceLabel(type, deText), type).toEqual({ text: deText(key), machine: false });
  });

  test("uses the singular workflow resource label in both locales", () => {
    const english = (key: TranslationKey, values?: Record<string, string | number>) =>
      translate("en", key, values);
    expect(auditResourceLabel("workflow", deText)).toEqual({ text: "Workflow", machine: false });
    expect(auditResourceLabel("workflow", english)).toEqual({
      text: "Workflow",
      machine: false,
    });
  });

  test("a type it does not know is the machine value, never a word for unknown", () => {
    expect(actorTypeLabel("robot", deText)).toEqual({ text: "robot", machine: true });
    expect(auditResourceLabel("robot", deText)).toEqual({ text: "robot", machine: true });
    expect(auditResultLabel("teapot", deText)).toEqual({ text: "teapot", machine: true });
    for (const label of [
      actorTypeLabel("robot", deText),
      auditResourceLabel("robot", deText),
      auditResultLabel("teapot", deText),
    ])
      expect(label.text).not.toBe(deText("common.unknown"));
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
    expect(auditActionLabel("schedule.admission.changed")).toEqual({
      kind: "named",
      key: "audit.action.scheduleAdmissionChanged",
    });
  });
});

describe("the decision trail is named", () => {
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
    "conversation.run_workflow",
    "tool_policy.confirmation_required",
    "credential.updated",
    "settings.revision_saved",
    "settings.revision_activated",
    "schedule.trigger.fired",
    "llm.invocation",
    "wait.started",
    "wait.completed",
    "webhook.trigger.failed_verification",
    "patch_candidate.closed_inapplicable",
    "mcp_oauth.client_retired",
    "mcp_oauth.client_reactivated",
    "mcp_oauth.client_disabled",
    "engine.restart.requested",
    "engine.restart.completed",
    "engine.restart.failed",
    "workflow.preview_auto_repaired",
    "auth_provider.added",
    "auth_provider.removed",
    "auth_provider.reordered",
    "auth_provider.changed",
    "product.added",
    "product.removed",
    "product.changed",
  ];

  test("every verb a person answers for has a name", () => {
    const unnamed = MUST_BE_NAMED.filter((action) => auditActionLabel(action).kind !== "named");
    expect(unnamed, `these read as machine values: ${unnamed.join(", ")}`).toEqual([]);
  });

  test("an unnamed verb is the engine's token, marked as one", () => {
    expect(auditActionLabel("some.future.verb")).toEqual({
      kind: "machine",
      value: "some.future.verb",
    });
  });

  test("both languages name every verb this build claims to name", () => {
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

describe("the two halves of the log", () => {
  test("decisions and operations are filtered on different axes", () => {
    expect(auditScopeParams("decisions")).toHaveProperty("action");
    expect(auditScopeParams("operations")).toEqual({ actor_type: "system" });
    expect(auditScopeParams("all")).toEqual({});
    expect(normalizedAuditScope("decisions", "workflow.deleted", "")).toBe("decisions");
    expect(normalizedAuditScope("decisions", "workflow.created", "")).toBe("all");
    expect(normalizedAuditScope("operations", "", "user")).toBe("all");
    expect(normalizedAuditScope("operations", "", "system")).toBe("operations");
  });

  test("the decision scope carries the verbs a person answers for", () => {
    const actions = auditScopeParams("decisions").action?.split(",") ?? [];
    for (const required of [
      "approval.granted",
      "approval.rejected",
      "policy.denied",
      "rbac.permission_granted",
      "user.deleted",
      "workflow.deleted",
      "secret.version_revoked",
      "settings.changed",
    ]) {
      expect(actions, `${required} is missing from the decision scope`).toContain(required);
    }
  });

  test("every verb in the decision scope has a name", () => {
    const unnamed = (auditScopeParams("decisions").action?.split(",") ?? []).filter(
      (action) => auditActionLabel(action).kind !== "named",
    );
    expect(unnamed, `unnamed in the decision scope: ${unnamed.join(", ")}`).toEqual([]);
  });

  test("an unknown scope from a link falls back to decisions, not to everything", () => {
    expect(isAuditScope("nonsense")).toBe(false);
    expect(isAuditScope("operations")).toBe(true);
  });
});

describe("searching what the reader can see", () => {
  const matches = (needle: string, action: string): boolean => {
    const n = needle.trim().toLowerCase();
    if (action.toLowerCase().includes(n)) return true;
    const label = auditActionLabel(action);
    return label.kind === "named" && translate("de", label.key).toLowerCase().includes(n);
  };

  test("finds a row by the words printed in its cell", () => {
    expect(matches("Einmal erlaubt", "approval.granted")).toBe(true);
    expect(matches("freigabe", "workflow.authority_granted")).toBe(true);
  });

  test("still finds a row by the engine's own token", () => {
    expect(matches("approval.granted", "approval.granted")).toBe(true);
    expect(matches("rbac.", "rbac.permission_revoked")).toBe(true);
  });

  test("does not match a row it has nothing to do with", () => {
    expect(matches("Freigabe", "mcp_oauth.client_registered")).toBe(false);
  });
});

describe("the correlation key a link carries", () => {
  test("takes a trace id from the URL", () => {
    expect(auditTraceFromUrl("?trace_id=cli-949cacce25ff4379")).toBe("cli-949cacce25ff4379");
    expect(auditTraceFromUrl("?scope=all&trace_id=abc123&result=denied")).toBe("abc123");
  });

  test("refuses what could not be one", () => {
    for (const bad of ["", "?trace_id=", "?trace_id=%20", "?trace_id=a b", "?trace_id=a/b"]) {
      expect(auditTraceFromUrl(bad)).toBeNull();
    }
    expect(auditTraceFromUrl(`?trace_id=${"x".repeat(129)}`)).toBeNull();
  });

  test("accepts the shapes the engine actually emits", () => {
    expect(auditTraceFromUrl("?trace_id=88d319e7e605b113183f5de6ca2745f9")).toBe(
      "88d319e7e605b113183f5de6ca2745f9",
    );
    expect(auditTraceFromUrl("?trace_id=cli-57bfffb088b04318")).toBe("cli-57bfffb088b04318");
  });
});

describe("the record behind a row", () => {
  test("an answer that is not a record is refused, not displayed", () => {
    for (const junk of [
      null,
      undefined,
      "",
      0,
      [],
      {},
      { items: [] },
      { id: 7, ts: "2026-08-10T09:00:00.000Z", action: "settings.changed" },
    ]) {
      expect(isAuditEntry(junk), `${JSON.stringify(junk) ?? "undefined"} passed as a record`).toBe(
        false,
      );
    }
  });

  test("the engine's own entry is accepted", () => {
    expect(isAuditEntry(ENTRY)).toBe(true);
  });
});

describe("the evidence the table dropped on the floor", () => {
  const kinds = (value: AuditEntry) => auditEvidenceBlocks(value).map((block) => block.kind);

  test("metadata is never a raw block beside the snapshots", () => {
    expect(auditEvidenceBlocks(entry({ metadata: { version: 7 } }))).toEqual([]);
  });

  test("a change is two blocks, before first", () => {
    const blocks = auditEvidenceBlocks(
      entry({ before: { retention_days: 30 }, after: { retention_days: 90 } }),
    );
    expect(blocks.map((block) => block.kind)).toEqual(["before", "after"]);
    expect(blocks[0]?.text).toContain("30");
    expect(blocks[1]?.text).toContain("90");
  });

  test("a half-recorded change keeps the half that exists", () => {
    expect(kinds(entry({ before: { retention_days: 30 } }))).toEqual(["before"]);
    expect(kinds(entry({ after: { retention_days: 90 } }))).toEqual(["after"]);
  });

  test("a record with no snapshots gets no blocks", () => {
    expect(auditEvidenceBlocks(ENTRY)).toEqual([]);
  });

  test("recorded emptiness is evidence; only absence is absent", () => {
    for (const recorded of [false, 0, "", [], {}]) {
      expect(
        kinds(entry({ before: recorded })),
        `${JSON.stringify(recorded)} was dropped as if unrecorded`,
      ).toEqual(["before"]);
    }
    expect(auditEvidenceBlocks(entry({ before: undefined, after: undefined }))).toEqual([]);
  });
});

describe("what one record says about itself", () => {
  const catalogue =
    (locale: Locale) =>
    (key: TranslationKey): string =>
      translate(locale, key);
  const de = catalogue("de");
  const dateTime = (value: string | Date): string => `absolute:${value.toString()}`;
  const labelled = (facts: ReturnType<typeof auditDetailFacts>, key: TranslationKey) =>
    facts.find((fact) => fact.label === de(key));

  test("absent is not empty, not zero and not the word null", () => {
    const facts = auditDetailFacts(
      entry({ actor_id: null, resource_id: null, reason: null, trace_id: null, ip: null }),
      de,
      dateTime,
    );
    for (const key of [
      "audit.detail.actorId",
      "audit.detail.resourceId",
      "audit.column.reason",
      "audit.detail.trace",
      "audit.detail.ip",
    ] as const) {
      expect(labelled(facts, key)?.value, `${key} is not reported as unrecorded`).toBeNull();
    }
    for (const fact of facts) {
      if (fact.value === null) continue;
      expect(fact.value.trim().length, `${fact.label} prints nothing`).toBeGreaterThan(0);
      expect(fact.value).not.toBe("null");
      expect(fact.value).not.toBe("undefined");
    }
  });

  test("a blank reason is unrecorded, the way the table already reads it", () => {
    expect(
      labelled(auditDetailFacts(entry({ reason: "   " }), de, dateTime), "audit.column.reason")
        ?.value,
    ).toBeNull();
    expect(
      labelled(
        auditDetailFacts(entry({ reason: "Rolle deckt skill:write nicht ab." }), de, dateTime),
        "audit.column.reason",
      )?.value,
    ).toBe("Rolle deckt skill:write nicht ab.");
  });

  test("every id is labelled and marked as a machine value", () => {
    const facts = auditDetailFacts(
      entry({ resource_id: "018f4b4a-6d33-7b3a-9c2d-bbbbbbbbbbbb" }),
      de,
      dateTime,
    );
    for (const key of [
      "audit.detail.actorId",
      "audit.detail.resourceId",
      "audit.detail.trace",
      "audit.detail.ip",
      "audit.detail.userAgent",
      "audit.detail.record",
    ] as const) {
      expect(labelled(facts, key)?.mono, `${key} is offered as prose`).toBe(true);
    }
    expect(labelled(facts, "audit.detail.record")?.value).toBe(ENTRY.id);
    expect(labelled(facts, "audit.detail.resourceId")?.value).toBe(
      "018f4b4a-6d33-7b3a-9c2d-bbbbbbbbbbbb",
    );
    expect(labelled(facts, "audit.column.actor")?.value).toBe(
      `${de("audit.actor.user")} · 018f4b4a…aaaaaaaaaaaa`,
    );
    expect(labelled(facts, "audit.column.resource")?.value).toBe(de("nav.settings"));
  });

  test("the timestamp is the absolute one, and it is the first thing said", () => {
    const facts = auditDetailFacts(ENTRY, de, dateTime);
    expect(facts[0]?.label).toBe(de("audit.column.time"));
    expect(facts[0]?.value).toBe(`absolute:${ENTRY.ts}`);
  });

  test("no two facts share a label, in either language", () => {
    for (const locale of ["en", "de"] as const) {
      const labels = auditDetailFacts(ENTRY, catalogue(locale), dateTime).map((fact) => fact.label);
      expect(new Set(labels).size, `a label is used twice in ${locale}: ${labels.join(", ")}`).toBe(
        labels.length,
      );
    }
  });

  test("the verb is not a fact in the list — it is the heading", () => {
    const facts = auditDetailFacts(ENTRY, de, dateTime);
    expect(facts.some((fact) => fact.value === ENTRY.action)).toBe(false);
    expect(
      facts.some((fact) => fact.value === translate("de", "audit.action.settingsChanged")),
    ).toBe(false);
  });

  test("the shared result map prints every outcome word in both languages", () => {
    const outcomes = [
      { result: "success", key: "audit.result.success", de: "Erfolgreich", en: "Succeeded" },
      { result: "error", key: "audit.result.error", de: "Fehlgeschlagen", en: "Failed" },
      { result: "denied", key: "audit.result.denied", de: "Verweigert", en: "Denied" },
    ] as const;

    for (const outcome of outcomes) {
      for (const locale of ["de", "en"] as const) {
        const t = catalogue(locale);
        const expected = outcome[locale];
        expect(translate(locale, outcome.key), `${outcome.key} in ${locale}`).toBe(expected);
        expect(auditResultLabel(outcome.result, t), `${outcome.result} in ${locale}`).toEqual({
          text: expected,
          machine: false,
        });
        const resultFact = auditDetailFacts(entry({ result: outcome.result }), t, dateTime).find(
          (fact) => fact.label === translate(locale, "audit.column.result"),
        );
        expect(resultFact?.value, `detail result ${outcome.result} in ${locale}`).toBe(expected);
      }
    }
  });

  test("both languages carry every word this sheet prints", () => {
    for (const key of [
      "audit.detail.actorId",
      "audit.detail.resourceId",
      "audit.detail.trace",
      "audit.detail.ip",
      "audit.detail.userAgent",
      "audit.detail.record",
      "audit.detail.before",
      "audit.detail.after",
      "audit.detail.metadata",
      "audit.detail.refreshFailed",
    ] as const) {
      for (const locale of ["en", "de"] as const) {
        const text = catalogue(locale)(key);
        expect(text.trim().length, `${key} has no ${locale} text`).toBeGreaterThan(0);
      }
      expect(translate("de", key), `${key} was never translated`).not.toBe(translate("en", key));
    }
  });
});
