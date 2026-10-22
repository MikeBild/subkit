import { describe, expect, test } from "bun:test";
import {
  type PlaybookDocument,
  type PlaybookPlan,
  PlaybookPlanSchema,
  type PlaybookStep,
} from "./playbook-contract.ts";
import {
  type PlaybookEvidenceMap,
  type PlaybookEvidenceResolution,
  projectPlaybook,
} from "./playbook-state.ts";

const resourceId = "00000000-0000-4000-8000-000000000001";
const evidenceId = "00000000-0000-4000-8000-000000000002";
const observedAt = "2026-01-01T12:00:00.000Z";

function step(
  id: string,
  criterion: PlaybookStep["criterion"],
  extra: Partial<PlaybookStep> = {},
): PlaybookStep {
  return {
    id,
    label: id,
    criterion,
    depends_on: [],
    evidence_ids: [evidenceId],
    note: null,
    progress: "open",
    next_action: null,
    ...extra,
  };
}

function observed(id: string, type: "connector" | "workflow" | "file" | "knowledge") {
  return step(id, { kind: "resource_observed", resource: { type, id: resourceId } });
}

function confirmation(id: string, goal: string, dependsOn: string[] = []) {
  return step(
    id,
    { kind: "human_confirmation", question: `Ist das Ziel „${goal}“ erreicht?` },
    { depends_on: dependsOn, progress: "waiting_for_input" },
  );
}

function successfulRun(id = "run") {
  return step(id, {
    kind: "execution_succeeded",
    workflow_id: resourceId,
    environment: "prod",
    after: observedAt,
  });
}

function evidence(
  freshness: "fresh" | "stale" | "unavailable" = "fresh",
  matches = freshness === "fresh",
): PlaybookEvidenceResolution {
  return {
    matches,
    reason: freshness === "fresh" ? "Passender Nachweis." : "Kein aktueller Nachweis.",
    evidence: {
      id: evidenceId,
      kind: "tool_call",
      label: "Nachweis",
      resource_type: null,
      resource_id: null,
      observed_at: observedAt,
      freshness,
      href: null,
    },
  };
}

function document(goal: string, steps: PlaybookStep[], completion: string | null = null) {
  const plan: PlaybookPlan = PlaybookPlanSchema.parse({
    title: "Prüfung",
    goal,
    steps,
    completion_step_id: completion,
    cancelled: false,
  });
  return {
    id: resourceId,
    plan,
    created_at: observedAt,
    updated_at: observedAt,
    evidence_fingerprints: {},
  } satisfies PlaybookDocument;
}

function project(
  doc: PlaybookDocument,
  entries: Array<[string, PlaybookEvidenceResolution]> = [],
  locale: "de" | "en" = "de",
) {
  const resolutions: PlaybookEvidenceMap = new Map(entries.map(([id, item]) => [id, [item]]));
  return projectPlaybook(doc, 3, resolutions, locale);
}

describe("playbook scenario projections with resolved evidence", () => {
  test("server-generated playbook guidance follows the requested locale", () => {
    const view = project(document("Check connector", [observed("inspect", "connector")]), [], "en");
    expect(view.summary).toContain("checks evidenced");
    expect(view.steps[0]?.criterion).toContain("referenced resource");
    expect(view.steps[0]?.reason).toContain("Matching current evidence is missing");
  });

  test("connector inspection alone does not establish operational readiness", () => {
    const view = project(document("Konnektor einsatzbereit", [observed("inspect", "connector")]), [
      ["inspect", evidence()],
    ]);
    expect(view.steps[0]?.status).toBe("verified");
    expect(view.completion.status).toBe("open");
    expect(view.status).not.toBe("completed");
  });

  test("live preparation preserves the outstanding human decision", () => {
    const goal = "Live-Vorbereitung geprüft";
    const view = project(
      document(
        goal,
        [observed("workflow", "workflow"), confirmation("decision", goal, ["workflow"])],
        "decision",
      ),
      [["workflow", evidence()]],
    );
    expect(view.steps[1]?.status).toBe("waiting_for_input");
    expect(view.steps[1]?.assurance).toBe("human");
    expect(view.completion.status).toBe("open");
  });

  test("reading a knowledge attachment does not confirm its admission", () => {
    const goal = "Wissensvorschlag fachlich geprüft";
    const view = project(
      document(goal, [observed("file", "file"), confirmation("review", goal, ["file"])], "review"),
      [["file", evidence()]],
    );
    expect(view.steps[0]?.status).toBe("verified");
    expect(view.steps[1]?.status).toBe("waiting_for_input");
    expect(view.status).not.toBe("completed");
  });

  test("failure recovery requires matching fresh execution evidence", () => {
    const doc = document("Erfolgreicher Nachlauf", [successfulRun()], "run");
    expect(project(doc, [["run", evidence("fresh", false)]]).completion.status).toBe("open");
    expect(project(doc, [["run", evidence()]]).completion.status).toBe("verified");
  });

  test("stale knowledge evidence cannot establish current data", () => {
    const view = project(document("Aktualität prüfen", [observed("source", "knowledge")]), [
      ["source", evidence("stale")],
    ]);
    expect(view.steps[0]?.status).toBe("stale");
    expect(view.completion.status).toBe("open");
  });

  test("missing permissions retain the responsible next action", () => {
    const action = {
      label: "orders.read prüfen",
      owner: "Dienstadministratorin",
      elicitation_id: null,
    };
    const doc = document("Benötigten Lesezugriff klären", [
      step(
        "access",
        { kind: "assessment", description: "orders.read fehlt", result: null },
        {
          progress: "blocked",
          next_action: action,
        },
      ),
    ]);
    const view = project(doc);
    expect(view.status).toBe("blocked");
    expect(view.summary).toContain("orders.read fehlt");
    expect(view.next_action).toEqual(action);
    expect(view.steps[0]?.assurance).toBe("assessment");
  });

  test("summary gives a concrete blocker priority over an earlier running step", () => {
    const doc = document("Zugriff klären", [
      step(
        "ongoing",
        { kind: "assessment", description: "Prüfung läuft", result: null },
        { progress: "in_progress" },
      ),
      step(
        "blocked",
        { kind: "assessment", description: "Zugriff prüfen", result: null },
        { progress: "blocked", note: "orders.read fehlt" },
      ),
    ]);
    const view = project(doc);
    expect(view.status).toBe("blocked");
    expect(view.summary).toContain("orders.read fehlt");
    expect(view.summary).not.toContain("Prüfung läuft");
  });

  test("summary surfaces a waiting human decision before other open work", () => {
    const doc = document("Zugriff klären", [
      step(
        "ongoing",
        { kind: "assessment", description: "Prüfung läuft", result: null },
        { progress: "in_progress" },
      ),
      confirmation("decision", "Zugriff klären"),
    ]);
    const view = project(doc);
    expect(view.status).toBe("waiting_for_input");
    expect(view.summary).toContain("Ist das Ziel");
  });

  test("an invalidated decision cannot cover an expanded approval boundary", () => {
    const goal = "Neue Schreibgrenze geprüft";
    const view = project(document(goal, [confirmation("review", goal)], "review"), [
      ["review", evidence("stale")],
    ]);
    expect(view.steps[0]?.status).toBe("stale");
    expect(view.completion.status).toBe("open");
  });

  test("unknown write effect cannot become a successful retry", () => {
    const doc = document("Wiederherstellung belegt", [successfulRun()], "run");
    doc.plan.steps[0] = {
      ...successfulRun(),
      progress: "blocked",
      note: "Schreibwirkung unbekannt.",
    };
    const view = project(doc, [["run", evidence("unavailable")]]);
    expect(view.status).toBe("blocked");
    expect(view.completion.status).toBe("open");
  });

  test("missing trigger observations do not establish a cause", () => {
    const doc = document("Ausbleibenden Start erklären", [
      step("cause", { kind: "assessment", description: "Ursache noch nicht belegt", result: null }),
    ]);
    const view = project(doc, [["cause", evidence()]]);
    expect(view.steps[0]?.status).toBe("open");
    expect(view.steps[0]?.assurance).toBe("assessment");
    expect(view.completion.status).toBe("open");
  });

  test("a delivered decision brief alone stays in progress without claiming factual verification", () => {
    const result =
      "Die Quelle enthält die Lieferbedingungen. Herkunft und Nutzungsrechte sind vor der Aufnahme zu bestätigen.";
    const doc = document("Entscheidungsvorlage liefern", [
      step("brief", { kind: "assessment", description: "Entscheidungsvorlage", result }),
    ]);
    const view = project(doc);
    expect(view.status).toBe("in_progress");
    expect(view.steps[0]?.status).toBe("assessment_ready");
    expect(view.steps[0]?.assurance).toBe("assessment");
    expect(view.steps[0]?.reason).toBe(result);
    expect(view.summary).toBe(result);
    expect(view.completion.status).toBe("open");
  });

  test("a model-declared blocker is not hidden by a delivered assessment", () => {
    const result = "Alle Schritte sind an eine PROD-Verbindung gebunden; ein Schritt passt nicht.";
    const view = project(
      document("Automatik vorbereiten", [
        step("review", { kind: "assessment", description: "Prüfung", result }),
        step(
          "binding",
          { kind: "assessment", description: "Bindung", result: `${result} Bindung offen.` },
          { progress: "blocked", note: "Bindung passt nicht zum Treiber." },
        ),
      ]),
    );
    expect(view.steps[1]?.status).toBe("blocked");
    expect(view.steps[1]?.reason).toBe(`${result} Bindung offen.`);
    expect(view.status).toBe("blocked");
    expect(view.summary).toContain(`${result} Bindung offen.`);
    expect(view.summary).not.toBe(result);
  });

  test("assessed steps with an open next action are not prepared", () => {
    const result = "Die Betriebsumgebung ist noch nicht fachlich festgelegt worden.";
    const view = project(
      document("Automatik vorbereiten", [
        step(
          "target",
          { kind: "assessment", description: "Umgebung", result },
          {
            evidence_ids: [],
            next_action: {
              label: "Gewünschte Betriebsumgebung fachlich festlegen",
              owner: "Betreiber",
              elicitation_id: null,
            },
          },
        ),
      ]),
    );
    expect(view.status).not.toBe("prepared");
    expect(view.next_action?.label).toBe("Gewünschte Betriebsumgebung fachlich festlegen");
  });

  test("a plan of assessments only is in progress", () => {
    const view = project(
      document("Automatik vorbereiten", [
        step("one", {
          kind: "assessment",
          description: "Eins",
          result: "Die erste Einschätzung liegt vollständig vor.",
        }),
        step("two", {
          kind: "assessment",
          description: "Zwei",
          result: "Die zweite Einschätzung liegt vollständig vor.",
        }),
      ]),
    );
    expect(view.status).toBe("in_progress");
    expect(view.steps.every((item) => item.status === "assessment_ready")).toBe(true);
  });

  test("a technically evidenced check with ready assessments stays in progress", () => {
    const view = project(
      document("Automatik vorbereiten", [
        observed("inspect", "workflow"),
        step("brief", {
          kind: "assessment",
          description: "Vorlage",
          result: "Die Prüfung des gespeicherten Entwurfs ist abgeschlossen.",
        }),
      ]),
      [["inspect", evidence()]],
    );
    expect(view.steps[0]?.status).toBe("verified");
    expect(view.status).toBe("in_progress");
  });

  test("a plan whose every check is technically evidenced is prepared", () => {
    const view = project(
      document("Automatik vorbereiten", [
        observed("inspect", "workflow"),
        observed("review", "workflow"),
      ]),
      [
        ["inspect", evidence()],
        ["review", evidence()],
      ],
    );
    expect(view.steps.every((item) => item.status === "verified")).toBe(true);
    expect(view.status).toBe("prepared");
  });

  test("long assessment summaries are visibly shortened", () => {
    const result = `${"Wichtiger Prüfstand. ".repeat(20)}Am Ende bleibt ein Freigabeschritt offen.`;
    const view = project(
      document("Vorlage prüfen", [
        step("brief", { kind: "assessment", description: "Vorlage", result }),
      ]),
    );
    expect(view.summary).toHaveLength(280);
    expect(view.summary.endsWith("…")).toBe(true);
    expect(view.steps[0]?.reason).toBe(result);
  });

  test("reading conflicting sources cannot resolve their factual precedence", () => {
    const doc = document("Wissenswiderspruch klären", [
      observed("source", "knowledge"),
      step(
        "precedence",
        { kind: "assessment", description: "Fachlicher Vorrang ungeklärt", result: null },
        {
          depends_on: ["source"],
        },
      ),
    ]);
    const view = project(doc, [
      ["source", evidence()],
      ["precedence", evidence()],
    ]);
    expect(view.steps[0]?.status).toBe("verified");
    expect(view.steps[1]?.status).toBe("open");
    expect(view.completion.status).toBe("open");
  });

  test("a saved workflow observation does not imply automation activation", () => {
    const view = project(document("Bericht automatisieren", [observed("draft", "workflow")]), [
      ["draft", evidence()],
    ]);
    expect(view.steps[0]?.status).toBe("verified");
    expect(view.status).not.toBe("completed");
  });

  test("resuming with an invalidated prerequisite blocks an otherwise accepted final decision", () => {
    const goal = "Fachliche Inhaltsprüfung bestätigt";
    const doc = document(
      goal,
      [observed("source", "knowledge"), confirmation("review", goal, ["source"])],
      "review",
    );
    const reloaded = JSON.parse(JSON.stringify(doc)) as PlaybookDocument;
    const view = project(reloaded, [
      ["source", evidence("stale")],
      ["review", evidence()],
    ]);
    expect(view.goal).toBe(goal);
    expect(view.revision).toBe(3);
    expect(view.steps[0]?.status).toBe("stale");
    expect(view.steps[1]?.status).toBe("blocked");
    expect(view.completion.status).toBe("open");
  });
});

describe("playbook completion contract", () => {
  test("an unavailable source hides retained free text and dependent assessment contents", () => {
    const confidential = "Vertrauliches Projekt Nachtigall";
    const source = observed("source", "knowledge");
    source.label = confidential;
    source.note = `${confidential}: alte Quellenbeschreibung`;
    source.next_action = {
      label: `${confidential}: öffnen`,
      owner: `${confidential}: zuständige Person`,
      elicitation_id: null,
    };
    const doc = document(`${confidential}: prüfen`, [
      source,
      step(
        "assessment",
        {
          kind: "assessment",
          description: `${confidential}: Fachprüfung`,
          result: `${confidential}: Diese vertrauliche Einschätzung stammt aus der gesperrten Quelle.`,
        },
        { depends_on: ["source"], label: confidential, next_action: source.next_action },
      ),
      step(
        "summary",
        {
          kind: "assessment",
          description: `${confidential}: Zusammenfassung`,
          result: `${confidential}: Gespeicherte Zusammenfassung ohne explizite Quellenabhängigkeit.`,
        },
        { label: confidential, next_action: source.next_action },
      ),
    ]);
    doc.plan.title = confidential;
    const view = project(doc, [["source", evidence("unavailable")]]);
    expect(JSON.stringify(view)).not.toContain(confidential);
    expect(view.steps[1]?.status).toBe("blocked");
    expect(view.steps.every((item) => item.next_action === null)).toBe(true);
    expect(view.next_action).toBeNull();
    expect(view.completion.status).toBe("open");
  });

  test("pending and cancelled completion labels describe a requirement rather than an achieved result", () => {
    const goal = "Entscheidungsvorlage fachlich geprüft";
    const human = project(document(goal, [confirmation("review", goal)], "review"));
    expect(human.completion.status).toBe("open");
    expect(human.completion.label).toContain("noch erforderlich");
    expect(human.completion.label).not.toContain("ist menschlich bestätigt");
    const run = document("Erfolgreicher Nachlauf", [successfulRun()], "run");
    expect(project(run).completion.label).toContain("nachweisen");
    run.plan.cancelled = true;
    const cancelled = project(run, [["run", evidence()]]);
    expect(cancelled.completion.label).toContain("nachweisen");
    expect(cancelled.completion.reason).not.toContain("Prüfkriterien sind erfüllt");
  });

  test("an observed resource cannot be selected as the final proof", () => {
    const doc = document("Konnektor einsatzbereit", [observed("inspect", "connector")]);
    expect(
      PlaybookPlanSchema.safeParse({ ...doc.plan, completion_step_id: "inspect" }).success,
    ).toBe(false);
  });

  test("a confirmation for another goal cannot close the current goal", () => {
    const goal = "Verfügbarkeit geprüft";
    const doc = document(goal, [confirmation("review", goal)], "review");
    expect(
      PlaybookPlanSchema.safeParse({ ...doc.plan, goal: "Schreibzugriff freigegeben" }).success,
    ).toBe(false);
  });

  test("a delivered assessment enables its explicit human review without becoming technical proof", () => {
    const goal = "Entscheidungsvorlage fachlich geprüft";
    const doc = document(
      goal,
      [
        step("brief", {
          kind: "assessment",
          description: "Vorlage",
          result: "Die Quelle und die offenen Nutzungsrechte sind in dieser Vorlage aufgeführt.",
        }),
        confirmation("review", goal, ["brief"]),
      ],
      "review",
    );
    const waiting = project(doc);
    expect(waiting.steps[0]?.status).toBe("assessment_ready");
    expect(waiting.steps[1]?.status).toBe("waiting_for_input");
    const confirmed = project(doc, [["review", evidence()]]);
    expect(confirmed.status).toBe("completed");
    expect(confirmed.steps[0]?.assurance).toBe("assessment");
    expect(confirmed.steps[1]?.assurance).toBe("human");
    expect(confirmed.completion.reason).toContain("keine zusätzliche Freigabe");
  });

  test("cancelling a previously verified plan does not report verified completion", () => {
    const doc = document("Erfolgreicher Nachlauf", [successfulRun()], "run");
    doc.plan.cancelled = true;
    const view = project(doc, [["run", evidence()]]);
    expect(view.status).toBe("cancelled");
    expect(view.completion.status).toBe("open");
    expect(view.next_action).toBeNull();
  });
});
