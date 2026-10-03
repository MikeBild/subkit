import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { components } from "@/api/schema";
import { ALL_ROUTE_PATHS } from "@/app/route-table";
import { type Locale, type TranslationKey, translate } from "@/lib/i18n";
import {
  actorTypeLabel,
  auditActionLabel,
  auditActionsFromUrl,
  auditActorName,
  auditDetailFacts,
  auditEvidenceBlocks,
  auditFilterFromUrl,
  auditLinkParams,
  auditReasonLabel,
  auditResourceHref,
  auditResourceLabel,
  auditResultLabel,
  auditScopeParams,
  auditTraceFromUrl,
  canReadDirectory,
  isAuditEntry,
  isAuditScope,
  LINKED_RESOURCE_TYPES,
  shortIdentifier,
} from "@/pages/audit-model";

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
    // The row naming a run is where an investigation starts. A run's address
    // is its sheet over Übersicht.
    expect(auditResourceHref("execution", "018f4b4a-6d33-7b3a-9c2d-123456789abc")).toBe(
      "/cockpit?run=018f4b4a-6d33-7b3a-9c2d-123456789abc",
    );
  });

  test("a missing id gets no link even when the type is known", () => {
    expect(auditResourceHref("workflow", null)).toBeNull();
  });

  test("every type that gets a link lands on a route this cockpit registers", () => {
    // Resolution, not plausibility. The parameter is not spelled the same on
    // every route — a conversation's segment is `$conversationId` — so what is
    // checked is the SHAPE: the target must be a registered path whose final
    // segment is the parameter this id fills.
    const detailPrefixes = new Set(
      ALL_ROUTE_PATHS.filter((path) => /\/\$[A-Za-z]+$/.test(path)).map((path) =>
        path.replace(/\/\$[A-Za-z]+$/, ""),
      ),
    );
    for (const type of LINKED_RESOURCE_TYPES) {
      const href = auditResourceHref(type, "018f4b4a-6d33-7b3a-9c2d-123456789abc");
      expect(href, `${type} is mapped but builds no link`).not.toBeNull();
      // A run is a sheet, addressed in the query of the start page.
      if (href?.startsWith("/cockpit?run=")) continue;
      const prefix = (href ?? "").replace(/^\/cockpit/, "").replace(/\/[^/]+$/, "");
      expect(detailPrefixes.has(prefix), `${type} points at ${href}, which no route matches`).toBe(
        true,
      );
    }
  });

  test("a type with only a list page stays a word, not a guessed path", () => {
    // Each of these reaches the log and each has a page — `/people`,
    // `/access`, `/api-access`, `/connections`, `/settings`. None of them
    // takes an id, so appending one would build an address no route matches,
    // and a link to a page that does not exist is worse than the plain text
    // it replaced. Nor is the list itself an honest target: it resolves
    // whether or not the row recorded an id, which is precisely the fact
    // `auditResourceHref` refuses to paper over.
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
      // The outbound connections the engine audits under `connection.*`.
      ["connection", "apiAccess.section.grants"],
    ];
    for (const [type, key] of named)
      expect(auditResourceLabel(type, deText), type).toEqual({ text: deText(key), machine: false });
  });

  test("a type it does not know is the machine value, never a word for unknown", () => {
    // "Unbekannt" and "Weitere Ressource" both claimed the log recorded
    // something indistinct; it recorded exactly this token (§2, §15.2).
    expect(actorTypeLabel("robot", deText)).toEqual({ text: "robot", machine: true });
    expect(auditResourceLabel("robot", deText)).toEqual({ text: "robot", machine: true });
    expect(auditResultLabel("teapot", deText)).toEqual({ text: "teapot", machine: true });
    for (const label of [
      actorTypeLabel("robot", deText),
      auditResourceLabel("robot", deText),
      auditResultLabel("teapot", deText),
    ])
      expect(label.text).not.toBe(deText("common.unknown"));
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
    // Added from the running installation rather than from the enum. A count
    // of "how many verbs are named" says nothing about a reader's screen: the
    // enum's long tail is housekeeping nobody opens, while these ten are
    // written by the thousand on a real tenant and are either a person's act
    // or the first thing someone looks for after an incident. Measured there:
    // 182 distinct verbs written, 96.8 % of rows now carrying a name.
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
    // Written by the engine, as the system, for every repair it proves it
    // cannot make — one row per closure, so on a live tenant it is common.
    "patch_candidate.closed_inapplicable",
    // The housekeeping sweep hides OAuth registrations nobody uses; the row
    // is the reason behind the Cockpit's "N stillgelegt" and must say so.
    "mcp_oauth.client_retired",
    "mcp_oauth.client_reactivated",
    "mcp_oauth.client_disabled",
    // A restart someone asked for from the settings page, and how it ended —
    // the toast after the restart links straight to these rows.
    "engine.restart.requested",
    "engine.restart.completed",
    "engine.restart.failed",
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

describe("the two halves of the log", () => {
  test("decisions and operations are filtered on different axes", () => {
    // Different questions. A person changing a setting is a decision whoever
    // typed it — that is the ACTION. The engine refreshing a token is
    // housekeeping whatever it touched — that is the ACTOR. Folding both onto
    // one axis loses one of the two questions.
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
    // A scope called "decisions" that renders machine tokens would defeat its
    // own purpose — a reader cannot audit what they cannot read.
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
  // The box narrows the rows already fetched — the engine matches `action`
  // exactly, so it cannot honestly become a query parameter. What it MATCHED
  // was the defect: the raw token, while the cell renders the German name. A
  // reader who saw "Freigabe erteilt" and typed it found nothing and had to
  // know the engine spells it `approval.granted`.
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
    // Whoever is quoting one into a ticket types the token, not the prose.
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
    // Forwarded to the engine as an exact match, a junk value narrows to
    // nothing and reads like an empty log rather than a bad query.
    for (const bad of ["", "?trace_id=", "?trace_id=%20", "?trace_id=a b", "?trace_id=a/b"]) {
      expect(auditTraceFromUrl(bad)).toBeNull();
    }
    expect(auditTraceFromUrl(`?trace_id=${"x".repeat(129)}`)).toBeNull();
  });

  test("accepts the shapes the engine actually emits", () => {
    // `cli-…` from the CLI, a bare hex span from the HTTP path.
    expect(auditTraceFromUrl("?trace_id=88d319e7e605b113183f5de6ca2745f9")).toBe(
      "88d319e7e605b113183f5de6ca2745f9",
    );
    expect(auditTraceFromUrl("?trace_id=cli-57bfffb088b04318")).toBe("cli-57bfffb088b04318");
  });
});

describe("the record behind a row", () => {
  test("an answer that is not a record is refused, not displayed", () => {
    // Every one of these arrives with a 200: a mistyped path, a proxy's
    // courtesy page, the visual fixture's catch-all. The row already holds the
    // whole record, so taking one of them for the answer would blank a sheet
    // the page could have filled — and blame the log for it.
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

  test("an empty metadata object renders nothing at all", () => {
    // Not an empty box. A drawn block claims the engine recorded something
    // inside it, and `{}` is the shape almost every row carries.
    expect(auditEvidenceBlocks(entry({ metadata: {} }))).toEqual([]);
  });

  test("metadata with something in it gets its block", () => {
    const blocks = auditEvidenceBlocks(entry({ metadata: { version: 7 } }));
    expect(blocks.map((block) => block.kind)).toEqual(["metadata"]);
    expect(blocks[0]?.text).toBe('{\n  "version": 7\n}');
  });

  test("a change is two blocks, before first", () => {
    // Read as one statement. The same pair in the other order says the
    // opposite of what happened.
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
    // A flag cleared to `false`, a limit set to `0`, a note blanked to `""`,
    // a list emptied to `[]`: each is what the engine wrote down, and each
    // falls out of a falsy test. `{}` is deliberately NOT the metadata rule
    // here — as a snapshot it is a state, as metadata it is an empty box.
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
  // Stands in for the surface's own absolute formatter, so the assertion is
  // about WHICH value is formatted rather than about a locale's punctuation.
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
    // Whatever IS printed is something to read. An empty string would reach
    // the page as a blank line that looks like a rendering fault.
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
    // A bare identifier in prose is banned on every surface a person reads.
    // These are not prose: they are what a reader copies into `sk audit show`
    // or a ticket, so the page prints them as machine values — and cannot,
    // unless the model says which ones they are.
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
    // Actor and resource are each a kind AND an id. One without the other is
    // either a word that names nobody or an id that says nothing about itself.
    expect(labelled(facts, "audit.column.actor")?.value).toBe(de("audit.actor.user"));
    expect(labelled(facts, "audit.column.resource")?.value).toBe(de("nav.settings"));
  });

  test("the timestamp is the absolute one, and it is the first thing said", () => {
    const facts = auditDetailFacts(ENTRY, de, dateTime);
    expect(facts[0]?.label).toBe(de("audit.column.time"));
    expect(facts[0]?.value).toBe(`absolute:${ENTRY.ts}`);
  });

  test("no two facts share a label, in either language", () => {
    // The surface renders this list keyed by label. Two labels that read the
    // same would silently collapse into one row, and the fact that vanished
    // would be an id — the half of the record nothing else on the page shows.
    for (const locale of ["en", "de"] as const) {
      const labels = auditDetailFacts(ENTRY, catalogue(locale), dateTime).map((fact) => fact.label);
      expect(new Set(labels).size, `a label is used twice in ${locale}: ${labels.join(", ")}`).toBe(
        labels.length,
      );
    }
  });

  test("the verb is not a fact in the list — it is the heading", () => {
    // A sheet titled with an id tells a reader nothing about what happened, so
    // the operation is the title. Repeating it here would make the heading
    // look like decoration rather than the statement it is.
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
    // Type-checking proves a German key EXISTS; it cannot tell an English
    // sentence pasted into the German block from a translation. None of these
    // words is spelled the same in both languages, so equality is the tell.
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
    // `konvention:check` reads `body.innerText()` and refuses UUID-shaped
    // text with NO exemption for a fenced block — that exemption belongs to
    // the visual sweep. Assuming it applied here failed the gate.
    const id = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
    const shown = shortIdentifier(id);
    expect(shown).toBe("018f4b4a…");
    expect(shown).not.toContain(id);
    expect(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(shown)).toBe(false);
  });

  test("leaves alone what is not a UUID", () => {
    // A trace id, an IP and a user agent are not UUIDs and are the whole
    // point of the row — shortening them would destroy the evidence.
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
    // Eight characters is what the CLI prints for a session.
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
    // Scope is not a parameter of its own: it becomes `action`/`actor_type`
    // through `auditScopeParams`, and sending it twice would be two sources.
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
    // The overview's repair rate links to the decided repairs exactly this way.
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
  const directory = new Map([
    ["018f4b4a-6d33-7b3a-9c2d-aaaaaaaaaaaa", "operator@example.com"],
    ["018f4b4a-6d33-7b3a-9c2d-bbbbbbbbbbbb", "Reporting bot"],
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

// Every resource type the engine writes to the log, named — read from the
// engine's own recorders, so a type added there without a name here fails
// this file. The engine has no enum for `resource_type`; the recorders are
// the catalogue. `runtime_secret` reached the "Art" column raw in production.
const ENGINE_SRC = resolve(import.meta.dir, "../../../engine/src");

function engineSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests invent resource types; the schema declares the column itself.
      if (["tests", "test", "test-helpers", "schema"].includes(entry.name)) continue;
      files.push(...engineSources(path));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Written through a variable rather than a literal at the recorder: the
 * approval surface (`resourceTypeOf`), the object-storage bridge
 * (`args.resourceType`) and the fallbacks in `audit.ts`, `dispatcher.ts` and
 * `require-permission.ts`.
 */
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
      // `surface === "mcp" ? "mcp_tool_call" : …` — the operand of a
      // comparison is not a value the recorder writes.
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
