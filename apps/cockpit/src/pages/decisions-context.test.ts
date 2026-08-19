import { describe, expect, test } from "bun:test";
import { buildNameIndex } from "@/lib/name-index";
import {
  answerKindKey,
  type ContextLabels,
  conversationContext,
  driftKindKey,
  patchContext,
  proposalKindKey,
  skillContext,
} from "./decisions-context";

const index = buildNameIndex(
  [{ id: "wf-1", name: "GA4 Tagesreport" }],
  [{ id: "co-1", name: "GitHub" }],
);

const labels: ContextLabels = {
  cause: "Ein Feld ist umgezogen",
  causeFallback: "Ursache unbekannt",
  failedRun: "Fehlgeschlagener Lauf",
  endpoint: "Konnektor",
  workflow: "Workflow",
  conversation: "Zur Unterhaltung",
  allWorkflows: "Gilt für alle Workflows",
  noTarget: "Ohne festes Ziel",
  pattern: "Aus einem wiederkehrenden Muster",
  observedCases: "aus 4 beobachteten Fällen",
};

const patch = {
  workflowId: "wf-1",
  workflowName: "GA4 Tagesreport",
  connectorId: "co-1",
  endpointKey: "GET /reports",
  executionId: "ex-1",
  driftKind: "schema_diff",
  driftSummary: "widened: data.id",
  reasoning: "the response moved the id under result",
  proposalKind: "update_field_path",
  classificationReasons: [],
  rejections: [],
};

describe("patchContext", () => {
  test("names the cause, the failing run and the endpoint that moved", () => {
    const { sources, targets } = patchContext(patch, labels, index, true);
    expect(sources.map((entry) => entry.label)).toEqual([
      "Ein Feld ist umgezogen",
      "Fehlgeschlagener Lauf",
      "GitHub",
    ]);
    expect(sources[2]?.note).toBe("GET /reports");
    expect(targets).toEqual([{ href: "/workflows/wf-1", label: "GA4 Tagesreport" }]);
  });

  test("drops the run link when the person cannot open runs", () => {
    // `execution:read` is evaluated per object, so a link for someone without
    // it resolves to a refusal — a missing link costs less than a dead one.
    const { sources } = patchContext(patch, labels, index, false);
    expect(sources.map((entry) => entry.label)).not.toContain("Fehlgeschlagener Lauf");
  });

  test("a candidate with no run keeps its cause and target", () => {
    const { sources, targets } = patchContext({ ...patch, executionId: null }, labels, index, true);
    expect(sources.map((entry) => entry.label)).toEqual(["Ein Feld ist umgezogen", "GitHub"]);
    expect(targets).toHaveLength(1);
  });

  test("an unknown cause says so rather than leaving the column empty", () => {
    const { sources } = patchContext(patch, { ...labels, cause: null }, index, true);
    expect(sources[0]?.label).toBe("Ursache unbekannt");
  });

  test("an id we hold stays a link even when the catalogue cannot name it", () => {
    // The route is valid whether or not the name is in the fetched page; only
    // the label degrades, and it degrades to the kind rather than to an id.
    const { sources } = patchContext({ ...patch, connectorId: "gone" }, labels, index, true);
    const endpoint = sources.find((entry) => entry.note === "GET /reports");
    expect(endpoint?.href).toBe("/connectors/gone");
    expect(endpoint?.label).toBe("Konnektor");
  });

  test("a workflow with no id and no name yields no target rather than an empty link", () => {
    const { targets } = patchContext(
      { ...patch, workflowId: null, workflowName: null },
      labels,
      index,
      true,
    );
    expect(targets).toEqual([]);
  });
});

describe("skillContext", () => {
  test("a workflow-scoped candidate links its workflow", () => {
    const { sources, targets } = skillContext(
      {
        scope: "workflow",
        workflowId: "wf-1",
        connectorId: null,
        endpointKey: null,
        evidenceCount: 4,
      },
      labels,
      index,
    );
    expect(sources.map((entry) => entry.label)).toEqual([
      "Aus einem wiederkehrenden Muster",
      "aus 4 beobachteten Fällen",
    ]);
    expect(targets).toEqual([{ href: "/workflows/wf-1", label: "GA4 Tagesreport" }]);
  });

  test("a scope we cannot name keeps its link and falls back to the kind", () => {
    const { targets } = skillContext(
      {
        scope: "workflow",
        workflowId: "gone",
        connectorId: null,
        endpointKey: null,
        evidenceCount: 1,
      },
      labels,
      index,
    );
    expect(targets).toEqual([{ href: "/workflows/gone", label: "Workflow" }]);
  });

  test("a connector-scoped candidate carries its endpoint as a qualifier", () => {
    const { targets } = skillContext(
      {
        scope: "connector",
        workflowId: null,
        connectorId: "co-1",
        endpointKey: "POST /graphql",
        evidenceCount: 1,
      },
      labels,
      index,
    );
    expect(targets[0]).toEqual({
      href: "/connectors/co-1",
      label: "GitHub",
      note: "POST /graphql",
    });
  });

  test("a global candidate states that it applies everywhere", () => {
    // This is a fact about the skill, not a missing target — the card must not
    // read as though something failed to resolve.
    const { targets } = skillContext(
      { scope: "global", workflowId: null, connectorId: null, endpointKey: null, evidenceCount: 8 },
      labels,
      index,
    );
    expect(targets).toEqual([{ href: null, label: "Gilt für alle Workflows" }]);
  });

  test("no evidence means no evidence line, not a zero", () => {
    const { sources } = skillContext(
      { scope: "global", workflowId: null, connectorId: null, endpointKey: null, evidenceCount: 0 },
      labels,
      index,
    );
    expect(sources).toHaveLength(1);
  });
});

describe("conversationContext", () => {
  test("the source is the conversation itself, as a link", () => {
    const { sources, targets } = conversationContext(
      { conversationId: "c-1", targetWorkflowId: "wf-1", targetConnectorId: null },
      labels,
      index,
    );
    expect(sources).toEqual([{ href: "/chat/c-1", label: "Zur Unterhaltung" }]);
    expect(targets).toEqual([{ href: "/workflows/wf-1", label: "GA4 Tagesreport" }]);
  });

  test("a conversation bound to nothing says so", () => {
    const { targets } = conversationContext(
      { conversationId: "c-1", targetWorkflowId: null, targetConnectorId: null },
      labels,
      index,
    );
    expect(targets).toEqual([{ href: null, label: "Ohne festes Ziel" }]);
  });

  test("ids are encoded, so a slug-shaped id cannot break the route", () => {
    const { sources } = conversationContext(
      { conversationId: "a/b c", targetWorkflowId: null, targetConnectorId: null },
      labels,
      index,
    );
    expect(sources[0]?.href).toBe("/chat/a%2Fb%20c");
  });
});

describe("vocabulary", () => {
  test("every drift and change kind the engine can send has a word", () => {
    for (const kind of [
      "http_status_new_shape",
      "jsonata_path_miss",
      "schema_diff",
      "stdlib_version_drift",
      "validation_failed",
      "endpoint_contract",
    ]) {
      expect(driftKindKey(kind)).not.toBeNull();
    }
    for (const kind of [
      "update_field_path",
      "rename_param",
      "change_type",
      "add_header",
      "rate_limited",
      "other",
    ]) {
      expect(proposalKindKey(kind)).not.toBeNull();
    }
  });

  test("an unrecognised kind yields null so the caller can fall back honestly", () => {
    expect(driftKindKey("something_new")).toBeNull();
    expect(driftKindKey(null)).toBeNull();
    expect(proposalKindKey("something_new")).toBeNull();
    expect(answerKindKey("some_new_prompt")).toBeNull();
    expect(answerKindKey(null)).toBeNull();
  });

  test("every prompting tool the engine can raise says what answer it wants", () => {
    for (const tool of [
      "ask_user_text",
      "ask_user_confirm",
      "ask_user_choice",
      "ask_user_multi",
      "ask_user_form",
      "ask_user_form_gate",
    ]) {
      expect(answerKindKey(tool)).not.toBeNull();
    }
  });

  test("the gate variant of a form asks for the same thing as a form", () => {
    // Two code paths, one thing wanted — a reader must not see two words for it.
    expect(answerKindKey("ask_user_form_gate")).toBe(answerKindKey("ask_user_form"));
  });
});
