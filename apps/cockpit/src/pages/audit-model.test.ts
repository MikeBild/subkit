import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { components } from "@/api/schema";
import { type ActorDirectory, actorDirectory, actorKey } from "@/app/actor-directory-model";
import { ALL_ROUTE_PATHS } from "@/app/route-table";
import { type Locale, type TranslationKey, translate } from "@/lib/i18n";
import { buildNameIndex } from "@/lib/name-index";
import {
  actorTypeLabel,
  auditActionLabel,
  auditActionsFromUrl,
  auditActorName,
  auditDetailFacts,
  auditEvidenceBlocks,
  auditFilterFromUrl,
  auditLinkParams,
  auditMetadataFacts,
  auditReasonLabel,
  auditResourceHref,
  auditResourceLabel,
  auditResultLabel,
  auditScopeParams,
  auditSearchActions,
  auditTraceFromUrl,
  canReadDirectory,
  isAuditEntry,
  isAuditScope,
  LINKED_RESOURCE_TYPES,
  searchedActionParams,
  shortIdentifier,
} from "@/pages/audit-model";
import { auditAreaParams, auditObjectName, initialAuditFilter } from "./audit-model";

type AuditEntry = components["schemas"]["AuditEntry"];

const ENTRY: AuditEntry = {
  id: "018f4b4a-6d33-7b3a-9c2d-123456789abc",
  ts: "2026-08-10T09:00:00.000Z",
  tenant_id: "018f4b4a-6d33-7b3a-9c2d-123456789abc",
  actor_type: "user",
  actor_id: "018f4b4a-6d33-7b3a-9c2d-aaaaaaaaaaaa",
  action: "settings.changed",
  resource_type: "settings",
  resource_id: null,
  resource_name: null,
  result: "success",
  trace_id: "cli-949cacce25ff4379",
  ip: "203.0.113.42",
  user_agent: "SubKit-CLI (macOS)",
  before: null,
  after: null,
  reason: null,
  metadata: {},
};

const entry = (patch: Partial<AuditEntry>): AuditEntry => ({ ...ENTRY, ...patch });
const deText = (key: TranslationKey): string => translate("de", key);
const absoluteTime = (value: string | Date): string => `absolute:${value.toString()}`;
const factFor = (facts: ReturnType<typeof auditDetailFacts>, key: TranslationKey) =>
  facts.find((fact) => fact.label === deText(key));

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
    expect(matches("Freigabe erteilt", "approval.granted")).toBe(true);
    expect(matches("freigabe", "approval.granted")).toBe(true);
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
    expect(labelled(facts, "audit.column.actor")?.value).toBe(de("audit.actor.user"));
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

  test("the outcome is read from the one map the table also reads", () => {
    expect(auditResultLabel("denied", de)).toEqual({
      text: de("audit.result.denied"),
      machine: false,
    });
    expect(
      labelled(auditDetailFacts(entry({ result: "denied" }), de, dateTime), "audit.column.result")
        ?.value,
    ).toBe(de("audit.result.denied"));
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

describe("identifiers a reader is shown", () => {
  test("a UUID is shortened, never printed whole", () => {
    const id = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
    const shown = shortIdentifier(id);
    expect(shown).toBe("018f4b4a…");
    expect(shown).not.toContain(id);
    expect(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(shown)).toBe(false);
  });

  test("leaves alone what is not a UUID", () => {
    for (const value of [
      "cli-949cacce25ff4379",
      "203.0.113.7",
      "sk/8.3.5",
      "tokens.monthly_budget",
    ]) {
      expect(shortIdentifier(value)).toBe(value);
    }
  });

  test("keeps enough to match a row against a log line", () => {
    expect(shortIdentifier("018f4b4a-6d33-7b3a-9c2d-123456789abc")).toContain("018f4b4a");
  });
});

describe("the narrowing a link brings to the log", () => {
  const id = "018f4b4a-6d33-7b3a-9c2d-123456789abc";

  test("reads a record, a request and a scope", () => {
    expect(
      auditFilterFromUrl(`?resource_type=workflow&resource_id=${id}&trace_id=abc123&scope=all`),
    ).toEqual({
      resourceType: "workflow",
      resourceId: id,
      traceId: "abc123",
      scope: "all",
      actions: [],
      tsFrom: null,
      tsTo: null,
    });
  });

  test("a record id without its type narrows nothing — the id alone names no record", () => {
    expect(auditFilterFromUrl(`?resource_id=${id}`).resourceId).toBeNull();
  });

  test("junk is dropped rather than sent as an exact match", () => {
    const filter = auditFilterFromUrl("?resource_type=a%20b&scope=everything&trace_id=a/b");
    expect(filter).toEqual({
      resourceType: null,
      resourceId: null,
      traceId: null,
      scope: null,
      actions: [],
      tsFrom: null,
      tsTo: null,
    });
  });

  test("becomes exactly the engine's own parameters", () => {
    expect(
      auditLinkParams({
        resourceType: "workflow",
        resourceId: id,
        traceId: null,
        scope: "all",
        actions: [],
        tsFrom: null,
        tsTo: null,
      }),
    ).toEqual({ resource_type: "workflow", resource_id: id });
    expect(
      auditLinkParams({
        resourceType: null,
        resourceId: null,
        traceId: "abc",
        scope: "all",
        actions: [],
        tsFrom: "2026-08-03T12:00:00.000Z",
        tsTo: null,
      }),
    ).toEqual({ trace_id: "abc", ts_from: "2026-08-03T12:00:00.000Z" });
  });

  test("the verbs a link names arrive as the engine's own comma list", () => {
    const filter = auditFilterFromUrl(
      "?scope=all&action=patch_candidate.approved,patch_candidate.auto_applied,patch_candidate.rejected",
    );
    expect(filter.actions).toEqual([
      "patch_candidate.approved",
      "patch_candidate.auto_applied",
      "patch_candidate.rejected",
    ]);
    expect(auditLinkParams(filter).action).toBe(
      "patch_candidate.approved,patch_candidate.auto_applied,patch_candidate.rejected",
    );
  });

  test("a malformed verb drops only itself, and repeats count once", () => {
    expect(auditActionsFromUrl("?action=a.b,DROP TABLE,a.b,,x/y,c_d.e")).toEqual(["a.b", "c_d.e"]);
    expect(auditActionsFromUrl("")).toEqual([]);
  });

  test("the link's verbs win over the decisions scope's own list", () => {
    const params = new URLSearchParams(auditScopeParams("decisions"));
    for (const [key, value] of Object.entries(
      auditLinkParams({ ...auditFilterFromUrl("?action=patch_candidate.closed_inapplicable") }),
    ))
      params.set(key, value);
    expect(params.get("action")).toBe("patch_candidate.closed_inapplicable");
  });

  test("the engine's closure is housekeeping, not a person's decision", () => {
    expect(auditScopeParams("decisions").action?.split(",")).not.toContain(
      "patch_candidate.closed_inapplicable",
    );
  });
});

describe("who caused a row (§15.2 Verursacher)", () => {
  test("colliding user and service identifiers keep their own names", () => {
    const colliding = actorDirectory(
      { items: [{ id: "same", email: "person@example.com" }] },
      { items: [{ id: "same", name: "Service" }] },
    );
    expect(auditActorName({ actor_type: "user", actor_id: "same" }, colliding, deText)?.text).toBe(
      "person@example.com",
    );
    expect(
      auditActorName({ actor_type: "system_account", actor_id: "same" }, colliding, deText)?.text,
    ).toBe("Service");
    expect(auditActorName({ actor_type: "", actor_id: "same" }, colliding, deText)).toBeNull();
  });
  const directory: ActorDirectory = new Map([
    [actorKey("user", "018f4b4a-6d33-7b3a-9c2d-aaaaaaaaaaaa"), "operator@example.com"],
    [actorKey("system_account", "018f4b4a-6d33-7b3a-9c2d-bbbbbbbbbbbb"), "Reporting bot"],
  ]);

  test("a person or system account by name", () => {
    expect(
      auditActorName(
        { actor_type: "user", actor_id: "018f4b4a-6d33-7b3a-9c2d-aaaaaaaaaaaa" },
        directory,
        deText,
      ),
    ).toEqual({ text: "operator@example.com", machine: false });
    expect(
      auditActorName(
        { actor_type: "system_account", actor_id: "018f4b4a-6d33-7b3a-9c2d-bbbbbbbbbbbb" },
        directory,
        deText,
      ),
    ).toEqual({ text: "Reporting bot", machine: false });
  });

  test("an actor the directory cannot name is its kind — never its id", () => {
    const label = auditActorName(
      { actor_type: "user", actor_id: "018f4b4a-6d33-7b3a-9c2d-cccccccccccc" },
      directory,
      deText,
    );
    expect(label).toEqual({ text: deText("audit.actor.user"), machine: false });
    expect(label?.text).not.toContain("018f4b4a");
    expect(auditActorName({ actor_type: "system", actor_id: null }, directory, deText)).toEqual({
      text: deText("audit.actor.system"),
      machine: false,
    });
  });

  test("no actor recorded is no actor — the dash, nothing inferred", () => {
    expect(auditActorName({ actor_type: "", actor_id: null }, directory, deText)).toBeNull();
  });

  test("the detail sheet names the same person the row does", () => {
    const facts = auditDetailFacts(
      entry({ actor_type: "user", actor_id: "018f4b4a-6d33-7b3a-9c2d-aaaaaaaaaaaa" }),
      deText,
      absoluteTime,
      directory,
    );
    expect(factFor(facts, "audit.column.actor")?.value).toBe("operator@example.com");
  });
});

describe("why a row happened", () => {
  test("a known reason token reads as a sentence", () => {
    expect(auditReasonLabel("expired_sliding", deText)).toEqual({
      text: deText("audit.reason.expiredSliding"),
      machine: false,
    });
  });

  test("an unknown token stays the engine's own, marked; prose stays prose", () => {
    expect(auditReasonLabel("quota_frobnicated", deText)).toEqual({
      text: "quota_frobnicated",
      machine: true,
    });
    expect(auditReasonLabel("Rolle deckt skill:write nicht ab.", deText)).toEqual({
      text: "Rolle deckt skill:write nicht ab.",
      machine: false,
    });
    expect(auditReasonLabel("  ", deText)).toBeNull();
    expect(auditReasonLabel(null, deText)).toBeNull();
  });
});

describe("whether the audit page asks for the directory", () => {
  test("only an administrator — anyone else's read is refused and itself audited", () => {
    const reader = (role_name: string | null, permissions: string[]) => ({
      permissions,
      principal: { role_name },
    });
    expect(canReadDirectory(reader("admin", ["identity:read", "audit:read"]))).toBe(true);
    expect(canReadDirectory(reader("Revision", ["identity:read", "audit:read"]))).toBe(false);
    expect(canReadDirectory(reader("admin", ["audit:read"]))).toBe(false);
  });
});

const ENGINE_SRC = resolve(import.meta.dir, "../../../engine/src");

function engineSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["tests", "test", "test-helpers", "schema"].includes(entry.name)) continue;
      files.push(...engineSources(path));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

const WRITTEN_THROUGH_A_VARIABLE = [
  "mcp_tool_call",
  "conversation_tool_call",
  "file",
  "execution_offload",
  "system",
  "tool",
  "policy",
];

function engineResourceTypes(): string[] {
  const types = new Set(WRITTEN_THROUGH_A_VARIABLE);
  for (const file of engineSources(ENGINE_SRC)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?<![a-z_])resource_type:\s*([^,\n}]+)/g)) {
      const written = (match[1] ?? "").replace(/[!=]==?\s*"[^"]*"/g, "");
      for (const literal of written.matchAll(/"([a-z][a-z0-9_]*)"/g))
        if (literal[1]) types.add(literal[1]);
    }
  }
  return [...types].sort();
}

const ENGINE_RESOURCE_TYPES = engineResourceTypes();

describe("the engine's audited resource types", () => {
  test("are read (a moved directory must not turn this into a vacuous pass)", () => {
    expect(ENGINE_RESOURCE_TYPES.length).toBeGreaterThan(50);
    expect(ENGINE_RESOURCE_TYPES).toContain("runtime_secret");
    expect(ENGINE_RESOURCE_TYPES).toContain("mcp_oauth_client");
  });

  for (const locale of ["de", "en"] as const) {
    const t = (key: TranslationKey, values?: Record<string, string | number>) =>
      translate(locale, key, values);

    test(`every resource type has a ${locale} name`, () => {
      const unnamed = ENGINE_RESOURCE_TYPES.filter((type) => auditResourceLabel(type, t).machine);
      expect(unnamed).toEqual([]);
    });

    test(`no ${locale} resource name is a word for unknown`, () => {
      for (const type of ENGINE_RESOURCE_TYPES) {
        const text = auditResourceLabel(type, t).text;
        expect(text).not.toContain(t("common.unknown"));
        expect(text).not.toBe(t("audit.resource.other"));
      }
    });
  }
});

describe("the additional details of one record", () => {
  const t = (key: TranslationKey, values?: Record<string, string | number>) =>
    translate("de", key, values);
  const names = buildNameIndex(
    [{ id: "6f1d6c2e-0000-4000-8000-000000000001", name: "Wochenbericht" }],
    [],
  );

  test("a workflow it names reads as the workflow's name and opens it", () => {
    const { facts, rest } = auditMetadataFacts(
      { workflow_id: "6f1d6c2e-0000-4000-8000-000000000001", version: 4 },
      t,
      names,
    );
    expect(facts.map((fact) => [fact.label, fact.value])).toEqual([
      ["Workflow", "Wochenbericht"],
      ["Version", "4"],
    ]);
    expect(facts[0]?.href).toContain("6f1d6c2e-0000-4000-8000-000000000001");
    expect(facts[1]?.href).toBeNull();
    expect(rest).toBeNull();
  });

  test("an unknown workflow still opens, without its identifier as the text", () => {
    const { facts } = auditMetadataFacts(
      { workflow_id: "6f1d6c2e-0000-4000-8000-0000000000ff" },
      t,
      names,
    );
    expect(facts[0]?.value).toBe("Workflow öffnen");
  });

  test("what has no reading of its own stays technical", () => {
    const { facts, rest } = auditMetadataFacts(
      { request_source: "cockpit", details: { a: 1 } },
      t,
      names,
    );
    expect(facts).toEqual([]);
    expect(rest).toContain("request_source");
  });

  test("an empty record has no additional details", () => {
    expect(auditMetadataFacts({}, t, names)).toEqual({ facts: [], rest: null });
  });
});

describe("searching the whole record, not the rows on screen", () => {
  const t = (key: TranslationKey, values?: Record<string, string | number>) =>
    translate("de", key, values);

  test("a word finds every operation it names, by label or by code", () => {
    const actions = auditSearchActions("gelöscht", t);
    expect(actions).toContain("connector.deleted");
    expect(auditSearchActions("connector.deleted", t)).toEqual(["connector.deleted"]);
    expect(auditSearchActions("zzz-nichts", t)).toEqual([]);
  });

  test("the search goes to the engine as an action filter", () => {
    expect(searchedActionParams({ result: "error" }, ["a.b", "c.d"])).toEqual({
      result: "error",
      action: "a.b,c.d",
    });
    expect(searchedActionParams({ result: "error" }, null)).toEqual({ result: "error" });
  });

  test("a search inside a filtered view keeps only what both allow", () => {
    expect(searchedActionParams({ action: "a.b,x.y" }, ["a.b", "c.d"])).toEqual({
      action: "a.b",
    });
    expect(searchedActionParams({ action: "x.y" }, ["a.b"])).toBeNull();
    expect(searchedActionParams({}, [])).toBeNull();
  });
});

test("audit areas select resource types on the server without changing actor identity", () => {
  expect(auditAreaParams("all")).toEqual({});
  expect(auditAreaParams("runs")).toEqual({ resource_types: "execution,execution_step" });
  expect(auditAreaParams("people").resource_types?.split(",")).toContain("user");
});

test("audit names prefer historical evidence and never guess from an identifier", () => {
  const names = buildNameIndex([{ id: "wf", name: "Current name" }], []);
  const t = (key: TranslationKey) => translate("de", key);
  expect(
    auditObjectName(
      { resource_type: "workflow", resource_id: "wf", resource_name: "Deleted name" },
      names,
      t,
    ),
  ).toBe("Deleted name");
  expect(
    auditObjectName(
      { resource_type: "workflow", resource_id: "wf", resource_name: null },
      names,
      t,
    ),
  ).toBe("Current name");
  expect(
    auditObjectName(
      { resource_type: "workflow", resource_id: "unknown", resource_name: null },
      names,
      t,
    ),
  ).toBe(t("resource.workflows.title"));
});

test("audit defaults to thirty days but keeps linked operation history unrestricted", () => {
  const now = Date.parse("2026-01-31T00:00:00Z");
  expect(initialAuditFilter("", now).tsFrom).toBe("2026-01-01T00:00:00.000Z");
  expect(initialAuditFilter("?trace_id=operation", now).tsFrom).toBeNull();
  expect(initialAuditFilter("?ts_from=2025-01-01T00:00:00Z", now).tsFrom).toBe(
    "2025-01-01T00:00:00.000Z",
  );
});
