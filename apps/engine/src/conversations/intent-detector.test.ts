import { describe, expect, test } from "bun:test";
import {
  detectEnvelopeResolution,
  detectMultiArtifactIntent,
  detectsAuthoringRequest,
  detectUserIntent,
  inferStateDrivenFollowUpTool,
  matchesEnumerationIntent,
  NO_SNAPSHOT_COVERAGE,
  resolvePreferredTool,
  turnToolChoice,
} from "./intent-detector.ts";
import type { AuthoringSummary } from "./types.ts";

describe("detectMultiArtifactIntent", () => {
  test("matches the canonical 'connector and a workflow' phrasing from session 1222158a", () => {
    expect(
      detectMultiArtifactIntent(
        "create a connector and a workflow to by weather api without api-key for tomorrow weather forecast in berlin germany",
      ),
    ).toBe(true);
  });

  test("matches the reverse order ('workflow ... and a connector')", () => {
    expect(detectMultiArtifactIntent("build a workflow and a connector for the GitHub API")).toBe(
      true,
    );
  });

  test("matches the German 'connector und einen workflow'", () => {
    expect(
      detectMultiArtifactIntent("erstelle einen connector und einen workflow für openweather"),
    ).toBe(true);
  });

  test("returns false when only one artifact is mentioned", () => {
    expect(detectMultiArtifactIntent("create a connector for github")).toBe(false);
    expect(detectMultiArtifactIntent("build me a workflow that hits the API")).toBe(false);
  });

  test("returns false on empty / nullish input", () => {
    expect(detectMultiArtifactIntent("")).toBe(false);
    expect(detectMultiArtifactIntent(null)).toBe(false);
    expect(detectMultiArtifactIntent(undefined)).toBe(false);
  });
});

function summary(overrides: Partial<AuthoringSummary> = {}): AuthoringSummary {
  return {
    readiness: "ready_to_save",
    next_action: "Commit the workflow now that inspection, validation, and preview are fresh.",
    next_required_action:
      "Commit the workflow now that inspection, validation, and preview are fresh.",
    next_suggested_tool: "save_workflow_draft",
    missing_fields: [],
    last_action: null,
    progress_label: "1 workflow step",
    mode: "workflow",
    stage: "workflow_previewed",
    lifecycle_state: "draft_only",
    active_target: {
      kind: "workflow",
      name: "ready-flow",
      slug: "ready-flow",
      id: null,
      environment: null,
      lifecycle_state: "draft_only",
    },
    blocked_by: [],
    checkpoints: [],
    persisted_resources: [],
    latest_execution: null,
    latest_diagnosis: null,
    ...overrides,
  };
}

describe("detectUserIntent", () => {
  test("an explicit request to send a problem exposes a separate saved operation", () => {
    const delivery = detectUserIntent("Bitte sende dieses Problem jetzt an den Dienst.");
    expect(delivery.requestExternalAction).toBe(true);
    expect(delivery.forceTool).toBeUndefined();
    expect(
      detectUserIntent("Das funktioniert nicht, bitte um Hilfe.").requestExternalAction,
    ).toBeUndefined();
    expect(
      detectUserIntent("Bitte sende dieses Problem nicht an den Dienst.").requestExternalAction,
    ).toBeUndefined();
  });
  test("reporting a problem exposes the saved operation without naming a recipient", () => {
    for (const message of [
      "Ich möchte ein Problem melden. Titel: Kein Versand",
      "Melde ein Problem",
      "Melde bitte dem Support ein Problem mit Diagnose.",
      "Report this problem to support",
    ]) {
      expect(detectUserIntent(message).requestExternalAction).toBe(true);
    }
    for (const message of [
      "Melde dieses Problem nicht.",
      "Dieses Problem nicht melden.",
      "Ich will kein Problem melden.",
    ]) {
      expect(detectUserIntent(message).requestExternalAction).toBeUndefined();
    }
  });
  test("authoring requests are told apart from ordinary requests", () => {
    expect(detectsAuthoringRequest("Erstelle einen Workflow für Rechnungen")).toBe(true);
    expect(detectsAuthoringRequest("Öffne meine Support-Seite")).toBe(false);
    expect(detectsAuthoringRequest("Zeig meine Support-Anfragen")).toBe(false);
    expect(detectsAuthoringRequest(null)).toBe(false);
  });
  test("a case status question exposes a saved read operation without requesting a send", () => {
    const status = detectUserIntent("Wie steht meine Anfrage Nummer 5?");
    expect(status.requestExternalRead).toBe(true);
    const separatedNoRun = detectUserIntent(
      "Bitte prüfe den Stand meiner Support-Anfrage Nummer 5. Den Entwurf bitte nicht ausführen.",
    );
    expect(separatedNoRun.requestExternalRead).toBe(true);
    expect(separatedNoRun.suppressExecution).toBe(true);
    expect(status.requestExternalAction).toBeUndefined();
    expect(detectUserIntent("Wie steht mein Entwurf?").requestExternalRead).toBeUndefined();
    expect(
      detectUserIntent("Bitte prüfe den Status meiner Anfrage nicht.").requestExternalRead,
    ).toBeUndefined();
  });
  test("recognizes German 'führe ... aus' as run intent", () => {
    const res = detectUserIntent("führe meine github workflow aus");
    expect(res.forceTool).toBe("run_workflow");
    expect(res.reason).toBe("explicit_run_intent");
  });

  test("recognizes 'run' verb + tool noun as run intent", () => {
    const res = detectUserIntent("please run this workflow");
    expect(res.forceTool).toBe("run_workflow");
  });

  test("recognizes bare 'ausführen' as run intent", () => {
    const res = detectUserIntent("ausführen");
    expect(res.forceTool).toBe("run_workflow");
  });

  test("German separated-verb negation suppresses execution", () => {
    const res = detectUserIntent(
      "Bearbeite den bestehenden Workflow-Draft, führe ihn in diesem Turn NICHT aus.",
    );
    expect(res.forceTool).toBeUndefined();
    expect(res.suppressExecution).toBe(true);
    expect(res.reason).toBe("explicit_no_run_intent");
  });

  test("German negated object and split verb suppress a saved-run request", () => {
    const res = detectUserIntent(
      "Untersuche den gespeicherten fehlgeschlagenen Lauf. Ändere nichts und führe keinen Lauf aus.",
    );
    expect(res.forceTool).toBeUndefined();
    expect(res.suppressExecution).toBe(true);
    expect(res.reason).toBe("explicit_no_run_intent");
  });

  test("German and English prefix negations suppress execution", () => {
    expect(detectUserIntent("Den Workflow nicht ausführen, sondern nur validieren.")).toMatchObject(
      { suppressExecution: true, reason: "explicit_no_run_intent" },
    );
    expect(detectUserIntent("Do not run the saved workflow; edit the draft only.")).toMatchObject({
      suppressExecution: true,
      reason: "explicit_no_run_intent",
    });
  });

  test("recognizes 'welche workflows habe ich' as enumeration → force no-tools", () => {
    const res = detectUserIntent("welche workflows habe ich");
    expect(res.forceTool).toBeUndefined();
    expect(res.forceNoTools).toBe(true);
    expect(res.reason).toBe("enumeration_answer_from_snapshot");
  });

  test("recognizes 'zeige alle meine workflows' as enumeration → force no-tools", () => {
    const res = detectUserIntent("zeige alle meine workflows");
    expect(res.forceNoTools).toBe(true);
  });

  test("recognizes 'wieviele connectors habe ich' as enumeration → force no-tools", () => {
    const res = detectUserIntent("wieviele connectors habe ich");
    expect(res.forceNoTools).toBe(true);
  });

  describe("enumeration steering follows snapshot completeness", () => {
    const complete = { workflows_complete: true, connectors_complete: true };
    const workflowsTrimmed = { workflows_complete: false, connectors_complete: true };
    const connectorsTrimmed = { workflows_complete: true, connectors_complete: false };

    test("a complete snapshot withholds tools", () => {
      expect(detectUserIntent("Zeig mir die notion-Workflows und was sie tun", complete)).toEqual({
        forceNoTools: true,
        reason: "enumeration_answer_from_snapshot",
      });
    });

    test("a turn without a principal has no snapshot, so tools stay and list_workflows leads", () => {
      const res = detectUserIntent("welche workflows habe ich", NO_SNAPSHOT_COVERAGE);
      expect(res.forceNoTools).toBeUndefined();
      expect(res.forceTool).toBe("list_workflows");
      expect(res.reason).toBe("enumeration_snapshot_trimmed");
    });

    test("trimmed workflows keep tools and force list_workflows for the first step", () => {
      const res = detectUserIntent(
        "Zeig mir die notion-Workflows und was sie tun",
        workflowsTrimmed,
      );
      expect(res.forceNoTools).toBeUndefined();
      expect(res.forceTool).toBe("list_workflows");
      expect(res.reason).toBe("enumeration_snapshot_trimmed");
    });

    test("trimmed connectors force list_connectors; complete workflows still answer from it", () => {
      expect(detectUserIntent("welche connectors habe ich", connectorsTrimmed).forceTool).toBe(
        "list_connectors",
      );
      expect(detectUserIntent("welche workflows habe ich", connectorsTrimmed).forceNoTools).toBe(
        true,
      );
    });

    test("a mixed question is only answered from the snapshot when every kind is complete", () => {
      const res = detectUserIntent("welche workflows und connectors habe ich", connectorsTrimmed);
      expect(res.forceNoTools).toBeUndefined();
      expect(res.forceTool).toBe("list_connectors");
    });

    test("a count is answered from the snapshot's exact totals even when its rows are trimmed", () => {
      for (const text of [
        "wie viele Workflows habe ich?",
        "wieviele workflows habe ich",
        "How many workflows do I have?",
        "Anzahl der Workflows",
        "workflows insgesamt",
        "number of workflows in my tenant",
      ]) {
        expect(detectUserIntent(text, workflowsTrimmed), text).toEqual({
          forceNoTools: true,
          reason: "enumeration_count_from_snapshot",
        });
      }
    });

    test("a count asked together with the rows still fetches the rows", () => {
      expect(
        detectUserIntent("wie viele workflows habe ich und welche sind es?", workflowsTrimmed)
          .forceTool,
      ).toBe("list_workflows");
    });

    test("a question naming an existing workflow pins nothing", () => {
      const named = { ...workflowsTrimmed, names_existing_workflow: true };
      expect(detectUserIntent("Zeig mir den Workflow customer-sync", named)).toEqual({
        reason: "enumeration_names_workflow",
      });
      expect(
        detectUserIntent("wie viele Schritte hat der workflow customer-sync?", {
          ...complete,
          names_existing_workflow: true,
        }),
      ).toEqual({ reason: "enumeration_names_workflow" });
    });

    test("a real enumeration on a trimmed snapshot still forces the list", () => {
      expect(
        detectUserIntent("welche workflows habe ich", {
          ...workflowsTrimmed,
          names_existing_workflow: false,
        }).forceTool,
      ).toBe("list_workflows");
    });

    test("matchesEnumerationIntent gates the coverage lookup", () => {
      expect(matchesEnumerationIntent("welche workflows habe ich")).toBe(true);
      expect(matchesEnumerationIntent("wieviele executions gibt es?")).toBe(false);
      expect(matchesEnumerationIntent(null)).toBe(false);
    });
  });

  test("'wieviele executions' is NOT enumeration — executions are not in the snapshot", () => {
    const res = detectUserIntent("wieviele executions gibt es?");
    expect(res.forceNoTools).toBeUndefined();
    expect(res.forceTool).toBeUndefined();
    expect(res.reason).toBe("no_strong_intent");
  });

  test("recognizes 'speichere den workflow' as commit intent", () => {
    const res = detectUserIntent("speichere den aktualisierten workflow");
    expect(res.forceTool).toBe("save_workflow_draft");
  });

  test("recognizes explicit new-workflow phrasing", () => {
    const res = detectUserIntent("create a workflow that gives me my private repos");
    expect(res.startNewWorkflow).toBe(true);
    expect(res.reason).toBe("explicit_new_workflow_intent");
  });

  test("new version of an existing workflow stays bound to that workflow", () => {
    const res = detectUserIntent(
      'Bearbeite ausschließlich den bestehenden Workflow "wf_existing" als neue persistierte Workflow-Version. Führe den Workflow NICHT aus.',
    );
    expect(res.startNewWorkflow).toBeUndefined();
    expect(res.forceTool).toBeUndefined();
    expect(res.suppressExecution).toBe(true);
    expect(res.reason).toBe("explicit_no_run_intent");
  });

  test("new workflow configuration is an in-place edit, not a new artifact", () => {
    const res = detectUserIntent(
      "Apply the new workflow configuration to the saved workflow; do not run it.",
    );
    expect(res.startNewWorkflow).toBeUndefined();
    expect(res.suppressExecution).toBe(true);
  });

  test.each([
    "Erzeuge ausdrücklich keinen neuen Workflow und bearbeite nur den bestehenden.",
    "Keinen neuen Workflow erzeugen; den gespeicherten Workflow aktualisieren.",
    "Bearbeite den vorhandenen Workflow, ohne einen neuen Workflow zu erstellen.",
    "Do not create a new workflow; update the selected workflow in place.",
    "Update the saved workflow without creating another workflow.",
  ])("negated new-workflow wording stays bound: %s", (message) => {
    const res = detectUserIntent(message);
    expect(res.startNewWorkflow).toBeUndefined();
    expect(res.forceTool).toBeUndefined();
  });

  test("sentence boundaries cannot join workflow-version wording to a later negated creation verb", () => {
    const res = detectUserIntent(
      "Bearbeite den bestehenden Workflow als neue persistierte Workflow-Version. Erzeuge ausdrücklich keinen neuen Workflow.",
    );
    expect(res.startNewWorkflow).toBeUndefined();
    expect(res.forceTool).toBeUndefined();
    expect(res.reason).toBe("no_strong_intent");
  });

  test("a later positive creation clause still wins over an earlier negated clause", () => {
    const res = detectUserIntent(
      "Do not modify the old workflow; create a new workflow for the replacement.",
    );
    expect(res.startNewWorkflow).toBe(true);
    expect(res.reason).toBe("explicit_new_workflow_intent");
  });

  test("returns no_strong_intent for ambiguous narrative", () => {
    const res = detectUserIntent(
      "ich glaube der Filter ist schon korrekt, vielleicht sollte ich nochmal schauen",
    );
    expect(res.forceTool).toBeUndefined();
    expect(res.reason).toBe("no_strong_intent");
  });

  test("returns no_user_text for null input", () => {
    expect(detectUserIntent(null).reason).toBe("no_user_text");
    expect(detectUserIntent(undefined).reason).toBe("no_user_text");
  });
});

describe("detectUserIntent — build-new beats ambiguous/negated run", () => {
  test("negated 'do NOT run' alongside a build request classifies as authoring", () => {
    const intent = detectUserIntent(
      'Build a NEW workflow called "Notion Page Reader". Do NOT run any existing essay workflow.',
    );
    expect(intent.startNewWorkflow).toBe(true);
    expect(intent.forceTool).toBeUndefined();
    expect(intent.reason).toBe("authoring_intent_over_ambiguous_run");
  });

  test("'create a new workflow ... do not run the existing notion one' → authoring", () => {
    const intent = detectUserIntent(
      "create a new workflow for reading Notion pages, do not run the existing notion-essay-to-markdown workflow",
    );
    expect(intent.startNewWorkflow).toBe(true);
    expect(intent.forceTool).toBeUndefined();
  });

  test("clean build-new phrasing still classifies as authoring", () => {
    const intent = detectUserIntent("create a workflow that reads a Notion page by URL");
    expect(intent.startNewWorkflow).toBe(true);
    expect(intent.forceTool).toBeUndefined();
    expect(intent.reason).toBe("explicit_new_workflow_intent");
  });

  test("genuine run phrasings (no authoring signal) still force run_workflow", () => {
    expect(detectUserIntent("führe den invoice workflow aus").forceTool).toBe("run_workflow");
    expect(detectUserIntent("please run this workflow").forceTool).toBe("run_workflow");
    expect(detectUserIntent("run my-jira-tickets workflow now").forceTool).toBe("run_workflow");
  });

  test("weak 'retry to create from scratch now' stays no_strong_intent at the classifier", () => {
    const intent = detectUserIntent("retry to create from scratch now");
    expect(intent.forceTool).toBeUndefined();
    expect(intent.startNewWorkflow).toBeUndefined();
    expect(intent.reason).toBe("no_strong_intent");
  });

  test("a neutral question is not run-intent", () => {
    expect(detectUserIntent("what does this workflow do?").forceTool).toBeUndefined();
  });
});

describe("detectEnvelopeResolution", () => {
  test("resolves 'approve' to approve", () => {
    expect(detectEnvelopeResolution("approve")).toBe("approve");
    expect(detectEnvelopeResolution("ok")).toBe("approve");
    expect(detectEnvelopeResolution("ja")).toBe("approve");
    expect(detectEnvelopeResolution("yes")).toBe("approve");
    expect(detectEnvelopeResolution("bestätige")).toBe("approve");
  });

  test("resolves 'reject' to reject", () => {
    expect(detectEnvelopeResolution("reject")).toBe("reject");
    expect(detectEnvelopeResolution("nein")).toBe("reject");
    expect(detectEnvelopeResolution("cancel")).toBe("reject");
    expect(detectEnvelopeResolution("abbrechen")).toBe("reject");
  });

  test("ignores long messages (not a one-word ack)", () => {
    expect(
      detectEnvelopeResolution(
        "ja aber bevor du das ausführst solltest du noch überlegen ob das korrekt ist",
      ),
    ).toBeNull();
  });

  test("ignores unrelated text", () => {
    expect(detectEnvelopeResolution("was ist der status?")).toBeNull();
    expect(detectEnvelopeResolution("zeige mir details")).toBeNull();
  });

  test("handles null / empty input", () => {
    expect(detectEnvelopeResolution(null)).toBeNull();
    expect(detectEnvelopeResolution("")).toBeNull();
    expect(detectEnvelopeResolution("   ")).toBeNull();
  });
});

describe("inferStateDrivenFollowUpTool", () => {
  test("maps a short approval onto save_workflow_draft for a ready workflow draft in auto mode", () => {
    expect(
      inferStateDrivenFollowUpTool({
        latestUserText: "yes",
        permission_mode: "auto",
        summary: summary(),
      }),
    ).toBe("save_workflow_draft");
  });

  test("maps a short approval onto save_connector_draft for a ready connector draft in auto mode", () => {
    expect(
      inferStateDrivenFollowUpTool({
        latestUserText: "ja",
        permission_mode: "auto",
        summary: summary({
          mode: "connector",
          stage: "connector_probed",
          next_action: "Save the connector now that inspection, validation, and probe are fresh.",
          next_required_action:
            "Save the connector now that inspection, validation, and probe are fresh.",
          next_suggested_tool: "save_connector_draft",
          active_target: {
            kind: "connector",
            name: "Acme API",
            slug: "acme-api",
            id: null,
            environment: "dev",
            lifecycle_state: "draft_only",
          },
        }),
      }),
    ).toBe("save_connector_draft");
  });

  test("does not force a follow-up tool outside auto mode", () => {
    expect(
      inferStateDrivenFollowUpTool({
        latestUserText: "yes",
        permission_mode: "ask",
        summary: summary(),
      }),
    ).toBeNull();
  });

  test("does not force a follow-up tool for non-save suggestions", () => {
    expect(
      inferStateDrivenFollowUpTool({
        latestUserText: "yes",
        permission_mode: "auto",
        summary: summary({
          lifecycle_state: "persisted",
          stage: "workflow_persisted",
          next_action: "Run the saved workflow to verify the persisted version.",
          next_required_action: "Run the saved workflow to verify the persisted version.",
          next_suggested_tool: "run_workflow",
          active_target: {
            kind: "workflow",
            name: "ready-flow",
            slug: "ready-flow",
            id: "wf_123",
            environment: null,
            lifecycle_state: "persisted",
          },
        }),
      }),
    ).toBeNull();
  });
});

describe("the turn's first-step tool choice", () => {
  const palette = (names: string[]) => (name: string) => names.includes(name);

  test("forces the detected tool when the palette carries it", () => {
    const tool = resolvePreferredTool(
      { forceTool: "list_workflows" },
      null,
      palette(["list_workflows"]),
    );
    expect(turnToolChoice(tool, false)).toEqual({ type: "tool", toolName: "list_workflows" });
  });

  test("a palette without list_workflows falls back to auto", () => {
    const tool = resolvePreferredTool(
      { forceTool: "list_workflows" },
      null,
      palette(["run_workflow"]),
    );
    expect(tool).toBeNull();
    expect(turnToolChoice(tool, false)).toBe("auto");
  });

  test("the state-driven follow-up only when the palette carries it", () => {
    expect(resolvePreferredTool({}, "save_workflow_draft", palette(["save_workflow_draft"]))).toBe(
      "save_workflow_draft",
    );
    expect(resolvePreferredTool({}, "save_workflow_draft", palette([]))).toBeNull();
  });

  test("an answer-from-snapshot turn withholds tools", () => {
    expect(turnToolChoice(null, true)).toBe("none");
  });
});

const PREPARE_WITHOUT_LIVE_EFFECTS =
  "Bereite diesen Ablauf für den automatischen Betrieb vor. Nicht aktivieren, keine Live-Wirkungen freigeben oder ausführen. Erlaubte Prüfungen selbst übernehmen; bei fehlender fachlicher Entscheidung kurze Frage mit Auswahl und Empfehlung.";

describe("live-effect suppression", () => {
  test("a no-activation, no-live-effects preparation suppresses only live execution", () => {
    const res = detectUserIntent(PREPARE_WITHOUT_LIVE_EFFECTS);
    expect(res.suppressLiveExecution).toBe(true);
    expect(res.suppressExecution).toBeUndefined();
    expect(res.forceTool).toBeUndefined();
  });

  test.each([
    "Bitte keinen Testlauf starten.",
    "Kein Probelauf, nur den Entwurf prüfen.",
    "No dry run please, just review the draft.",
    "Den Workflow bitte nicht testen.",
  ])("an explicit no-test instruction suppresses previews too: %s", (message) => {
    const res = detectUserIntent(message);
    expect(res.suppressExecution).toBe(true);
    expect(res.suppressLiveExecution).toBe(true);
  });

  test.each([
    "Do not activate it and no live effects.",
    "Nichts live auslösen, nur vorbereiten.",
    "Aktiviere den Workflow nicht.",
  ])("live-effect negations suppress live execution: %s", (message) => {
    expect(detectUserIntent(message)).toMatchObject({ suppressLiveExecution: true });
    expect(detectUserIntent(message).suppressExecution).toBeUndefined();
  });

  test("a question about activation is no instruction", () => {
    expect(
      detectUserIntent("Warum kann ich den Workflow nicht aktivieren?").suppressLiveExecution,
    ).toBeUndefined();
  });

  test("a plain run request suppresses nothing", () => {
    const res = detectUserIntent("Run the workflow");
    expect(res.suppressExecution).toBeUndefined();
    expect(res.suppressLiveExecution).toBeUndefined();
  });

  test("an explicit no-run instruction implies live suppression", () => {
    expect(detectUserIntent("Den Workflow nicht ausführen, sondern nur validieren.")).toMatchObject(
      { suppressExecution: true, suppressLiveExecution: true, reason: "explicit_no_run_intent" },
    );
  });
});
