import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type TranslationKey, translate } from "@/lib/i18n";
import { UNNAMED_AUDIT_ACTIONS } from "@/pages/audit-action-backlog";
import {
  ACTION_KEYS,
  auditActionLabel,
  auditActionsFromUrl,
  auditActorName,
  auditCountKey,
  auditDetailFacts,
  auditFilterFromUrl,
  auditLinkParams,
  auditMetadataFacts,
  auditReasonLabel,
  auditResourceLabel,
  auditScopeParams,
  auditSearchActions,
  canReadDirectory,
  searchedActionParams,
  shortIdentifier,
} from "@/pages/audit-model";
import { AUDIT_AREAS, auditAreaParams, auditObjectName, initialAuditFilter } from "./audit-model";
import { deText, entry } from "./audit-model-fixtures.ts";

const absoluteTime = (value: string | Date): string => `absolute:${value.toString()}`;

const factFor = (facts: ReturnType<typeof auditDetailFacts>, key: TranslationKey) =>
  facts.find((fact) => fact.label === deText(key));

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
  test("colliding user and service identifiers keep their recorded actor types", () => {
    expect(auditActorName({ actor_type: "user", actor_id: "same" }, deText)?.text).toBe(
      `${deText("audit.actor.user")} · same`,
    );
    expect(auditActorName({ actor_type: "system_account", actor_id: "same" }, deText)?.text).toBe(
      `${deText("audit.actor.systemAccount")} · same`,
    );
    expect(auditActorName({ actor_type: "unknown", actor_id: null }, deText)).toEqual({
      text: deText("audit.actor.unknown"),
      machine: false,
    });
  });

  test("a person or system account by stable ID without present-day directory names", () => {
    expect(
      auditActorName(
        { actor_type: "user", actor_id: "018f4b4a-6d33-7b3a-9c2d-aaaaaaaaaaaa" },
        deText,
      ),
    ).toEqual({
      text: `${deText("audit.actor.user")} · 018f4b4a…aaaaaaaaaaaa`,
      machine: false,
    });
    expect(
      auditActorName(
        { actor_type: "system_account", actor_id: "018f4b4a-6d33-7b3a-9c2d-bbbbbbbbbbbb" },
        deText,
      ),
    ).toEqual({
      text: `${deText("audit.actor.systemAccount")} · 018f4b4a…bbbbbbbbbbbb`,
      machine: false,
    });
  });

  test("actors with the same UUID prefix remain distinct in timeline labels", () => {
    const label = auditActorName(
      { actor_type: "user", actor_id: "018f4b4a-6d33-7b3a-9c2d-cccccccccccc" },
      deText,
    );
    expect(label).toEqual({
      text: `${deText("audit.actor.user")} · 018f4b4a…cccccccccccc`,
      machine: false,
    });
    expect(auditActorName({ actor_type: "system", actor_id: null }, deText)).toEqual({
      text: deText("audit.actor.system"),
      machine: false,
    });
  });

  test("unavailable actor provenance is labeled unknown", () => {
    expect(auditActorName({ actor_type: "unknown", actor_id: null }, deText)).toEqual({
      text: deText("audit.actor.unknown"),
      machine: false,
    });
  });

  test("the detail sheet keeps the full recorded actor ID as its own fact", () => {
    const facts = auditDetailFacts(
      entry({ actor_type: "user", actor_id: "018f4b4a-6d33-7b3a-9c2d-aaaaaaaaaaaa" }),
      deText,
      absoluteTime,
    );
    expect(factFor(facts, "audit.column.actor")?.value).toBe(
      `${deText("audit.actor.user")} · 018f4b4a…aaaaaaaaaaaa`,
    );
    expect(factFor(facts, "audit.detail.actorId")?.value).toBe(
      "018f4b4a-6d33-7b3a-9c2d-aaaaaaaaaaaa",
    );
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

function engineAuditActions(): string[] {
  const source = readFileSync(join(ENGINE_SRC, "audit/types.ts"), "utf8");
  const start = source.indexOf("export const AuditAction");
  const body = source.slice(start, source.indexOf("} as const", start));
  return [...body.matchAll(/^\s+[A-Z0-9_]+:\s*"([a-z0-9_.:-]+)"/gm)]
    .map((match) => match[1] ?? "")
    .sort();
}

const ENGINE_AUDIT_ACTIONS = engineAuditActions();

describe("the engine's audit actions", () => {
  test("are read (a moved file must not turn this into a vacuous pass)", () => {
    expect(ENGINE_AUDIT_ACTIONS.length).toBeGreaterThan(300);
    expect(ENGINE_AUDIT_ACTIONS).toContain("desktop_login.completed");
    expect(ENGINE_AUDIT_ACTIONS).toContain("session.issued");
  });

  test("every action has a name, except the recorded backlog of older actions", () => {
    const unnamed = ENGINE_AUDIT_ACTIONS.filter((action) => !(action in ACTION_KEYS));
    expect(unnamed).toEqual([...UNNAMED_AUDIT_ACTIONS]);
  });

  test("the backlog only shrinks: nothing in it is named, unknown or listed twice", () => {
    expect(UNNAMED_AUDIT_ACTIONS.filter((action) => action in ACTION_KEYS)).toEqual([]);
    expect(
      UNNAMED_AUDIT_ACTIONS.filter((action) => !ENGINE_AUDIT_ACTIONS.includes(action)),
    ).toEqual([]);
    expect(new Set(UNNAMED_AUDIT_ACTIONS).size).toBe(UNNAMED_AUDIT_ACTIONS.length);
  });

  for (const locale of ["de", "en"] as const) {
    test(`every named action has a ${locale} label that is not its machine name`, () => {
      for (const [action, key] of Object.entries(ACTION_KEYS)) {
        const text = translate(locale, key);
        expect(text.length, action).toBeGreaterThan(2);
        expect(text, action).not.toBe(action);
      }
    });
  }

  test("signing a desktop device in and out reads in plain words", () => {
    const de = (action: string) => {
      const label = auditActionLabel(action);
      return label.kind === "named" ? translate("de", label.key) : null;
    };
    expect(de("desktop_login.code_issued")).toBe("Anmeldung der Desktop-App im Browser bestätigt");
    expect(de("desktop_login.denied")).toBe("Anmeldung der Desktop-App abgelehnt");
    expect(de("desktop_login.completed")).toBe("Desktop-App angemeldet");
    expect(de("cockpit_installation.revoked")).toBe(
      "Installierte App oder Desktop-Gerät abgemeldet",
    );
  });
});

describe("the additional details of one record", () => {
  const t = (key: TranslationKey, values?: Record<string, string | number>) =>
    translate("de", key, values);

  test("a workflow reference uses its ID rather than the workflow's current name", () => {
    const { facts, rest } = auditMetadataFacts(
      { workflow_id: "6f1d6c2e-0000-4000-8000-000000000001", version: 4 },
      t,
    );
    expect(facts.map((fact) => [fact.label, fact.value])).toEqual([
      ["Workflow", "Workflow öffnen · 6f1d6c2e-0000-4000-8000-000000000001"],
      ["Version", "4"],
    ]);
    expect(facts[0]?.href).toContain("6f1d6c2e-0000-4000-8000-000000000001");
    expect(facts[1]?.href).toBeNull();
    expect(rest).toBeNull();
  });

  test("an unknown workflow reference still opens with its identifier visible", () => {
    const { facts } = auditMetadataFacts(
      { workflow_id: "6f1d6c2e-0000-4000-8000-0000000000ff" },
      t,
    );
    expect(facts[0]?.value).toBe("Workflow öffnen · 6f1d6c2e-0000-4000-8000-0000000000ff");
  });

  test("what has no reading of its own stays technical", () => {
    const { facts, rest } = auditMetadataFacts({ request_source: "cockpit", details: { a: 1 } }, t);
    expect(facts).toEqual([]);
    expect(rest).toContain("request_source");
  });

  test("an empty record has no additional details", () => {
    expect(auditMetadataFacts({}, t)).toEqual({ facts: [], rest: null });
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
  expect(AUDIT_AREAS).toEqual({
    all: [],
    runs: ["execution", "execution_step"],
    workflows: [
      "workflow",
      "workflow_version",
      "workflow_execution_authority",
      "workflow_schedule",
    ],
    connectors: ["connector", "credential", "connection"],
    knowledge: ["knowledge_source", "knowledge_source_version", "skill", "skill_candidate"],
    files: ["file"],
    conversations: ["conversation", "conversation_elicitation"],
    tasks: ["task", "task_run", "task_grant"],
    people: [
      "user",
      "user_identity",
      "group",
      "role",
      "resource_grant",
      "api_key",
      "system_account",
      "mcp_oauth_client",
    ],
  });
  expect(
    Object.fromEntries(
      Object.keys(AUDIT_AREAS).map((area) => [
        area,
        auditAreaParams(area as keyof typeof AUDIT_AREAS),
      ]),
    ),
  ).toEqual({
    all: {},
    runs: { resource_types: "execution,execution_step" },
    workflows: {
      resource_types: "workflow,workflow_version,workflow_execution_authority,workflow_schedule",
    },
    connectors: { resource_types: "connector,credential,connection" },
    knowledge: {
      resource_types: "knowledge_source,knowledge_source_version,skill,skill_candidate",
    },
    files: { resource_types: "file" },
    conversations: { resource_types: "conversation,conversation_elicitation" },
    tasks: { resource_types: "task,task_run,task_grant" },
    people: {
      resource_types:
        "user,user_identity,group,role,resource_grant,api_key,system_account,mcp_oauth_client",
    },
  });
});

test("audit names use recorded event-time evidence and stable IDs, not current names", () => {
  const t = (key: TranslationKey) => translate("de", key);
  expect(
    auditObjectName(
      { resource_type: "workflow", resource_id: "wf", resource_name: "Deleted name" },
      t,
    ),
  ).toBe("Deleted name");
  expect(
    auditObjectName({ resource_type: "workflow", resource_id: "wf", resource_name: null }, t),
  ).toBe(`${t("audit.resource.workflow")} · wf`);
  expect(
    auditObjectName({ resource_type: "workflow", resource_id: "unknown", resource_name: null }, t),
  ).toBe(`${t("audit.resource.workflow")} · unknown`);
});

test("audit defaults to thirty days but keeps linked operation history unrestricted", () => {
  const now = Date.parse("2026-01-31T00:00:00Z");
  expect(initialAuditFilter("", now).tsFrom).toBe("2026-01-01T00:00:00.000Z");
  expect(initialAuditFilter("?trace_id=operation", now).tsFrom).toBeNull();
  expect(
    initialAuditFilter("?correlation_id=0123456789abcdef0123456789abcdef", now).tsFrom,
  ).toBeNull();
  expect(initialAuditFilter("?correlation_id=invalid", now).tsFrom).toBe(
    "2026-01-01T00:00:00.000Z",
  );
  expect(initialAuditFilter("?ts_from=2025-01-01T00:00:00Z", now).tsFrom).toBe(
    "2025-01-01T00:00:00.000Z",
  );
});

test("audit count names the implicit thirty-day window and preserves linked-range copy", () => {
  const implicit = initialAuditFilter("", Date.parse("2026-01-31T00:00:00Z"));
  expect(auditCountKey("", implicit, 2, false)).toBe("audit.countWindow");
  expect(auditCountKey("", implicit, 1, false)).toBe("audit.countWindow.one");
  expect(auditCountKey("", implicit, 2, true)).toBe("audit.countWindowMore");

  const linked = initialAuditFilter("?ts_from=2025-01-01T00:00:00Z", 1_760_000_000_000);
  expect(auditCountKey("?ts_from=2025-01-01T00:00:00Z", linked, 2, false)).toBe("audit.count");
  expect(auditCountKey("", { ...implicit, tsFrom: null }, 2, false)).toBe("audit.count");
  expect(
    auditCountKey("?correlation_id=0123456789abcdef0123456789abcdef", implicit, 2, false),
  ).toBe("audit.count");
});
