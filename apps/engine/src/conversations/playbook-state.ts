import type {
  PlaybookDocument,
  PlaybookEvidence,
  PlaybookStep,
  PlaybookView,
} from "./playbook-contract.ts";

export interface PlaybookEvidenceResolution {
  evidence: PlaybookEvidence;
  matches: boolean;
  reason: string;
}
export type PlaybookEvidenceMap = ReadonlyMap<string, readonly PlaybookEvidenceResolution[]>;

export function criterionLabel(step: PlaybookStep, locale: "de" | "en" = "de"): string {
  switch (step.criterion.kind) {
    case "assessment":
      return step.criterion.description;
    case "resource_observed":
      return locale === "en"
        ? "The referenced resource was actually read. This does not confirm any further subject-matter claim."
        : "Die angegebene Ressource wurde tatsächlich gelesen. Dies bestätigt keine darüber hinausgehende fachliche Aussage.";
    case "execution_succeeded":
      return locale === "en"
        ? `A new successful run of the current workflow version in ${step.criterion.environment.toUpperCase()} after ${step.criterion.after}.`
        : `Ein neuer erfolgreicher Lauf der aktuellen Workflow-Version in ${step.criterion.environment.toUpperCase()} nach ${step.criterion.after}.`;
    case "human_confirmation":
      return step.criterion.question;
  }
}

export function projectPlaybook(
  document: PlaybookDocument,
  revision: number,
  evidenceMap: PlaybookEvidenceMap,
  locale: "de" | "en" = "de",
): PlaybookView {
  const en = locale === "en";
  const verified = new Set<string>();
  const ready = new Set<string>();
  const inaccessible = new Set<string>();
  const steps: PlaybookView["steps"] = document.plan.steps.map((step) => {
    const resolutions = evidenceMap.get(step.id) ?? [];
    const accepted = resolutions.find(
      (item) => item.matches && item.evidence.freshness === "fresh",
    );
    const dependenciesMet = step.depends_on.every((id) => ready.has(id));
    const assessment = step.criterion.kind === "assessment";
    const unavailable =
      resolutions.some((item) => item.evidence.freshness === "unavailable") ||
      step.depends_on.some((id) => inaccessible.has(id));
    if (unavailable) inaccessible.add(step.id);
    const stale = resolutions.some((item) => item.evidence.freshness === "stale");
    const delivered = step.criterion.kind === "assessment" && step.criterion.result !== null;
    const heldByModel = step.progress === "blocked" || step.progress === "waiting_for_input";
    const status = !dependenciesMet
      ? "blocked"
      : delivered && !heldByModel
        ? "assessment_ready"
        : !assessment && accepted
          ? "verified"
          : stale
            ? "stale"
            : step.progress;
    if (status === "verified") verified.add(step.id);
    if (status === "verified" || status === "assessment_ready") ready.add(step.id);
    return {
      id: step.id,
      label: unavailable
        ? en
          ? "Check currently inaccessible"
          : "Prüfschritt derzeit nicht zugänglich"
        : step.label,
      criterion: unavailable
        ? en
          ? "Recheck the evidence with sufficient permission."
          : "Der Beleg muss mit ausreichender Berechtigung erneut geprüft werden."
        : criterionLabel(step, locale),
      depends_on: step.depends_on,
      status,
      reason: unavailable
        ? en
          ? "The evidence is no longer available or the required read permission is missing."
          : "Der Beleg ist nicht mehr verfügbar oder die erforderliche Leseberechtigung fehlt."
        : !dependenciesMet
          ? en
            ? "A preceding check is still open."
            : "Ein vorausgehender Prüfschritt ist noch offen."
          : accepted && !assessment
            ? accepted.reason
            : step.criterion.kind === "assessment"
              ? (step.criterion.result ??
                step.note ??
                (en
                  ? "AI assessment has not been created yet."
                  : "KI-Einschätzung noch nicht erstellt."))
              : stale
                ? en
                  ? "The earlier evidence no longer applies to the current state. Check again."
                  : "Der frühere Beleg gilt nicht mehr für den aktuellen Stand. Erneut prüfen."
                : (step.note ??
                  resolutions[0]?.reason ??
                  (en
                    ? "Matching current evidence is missing."
                    : "Ein passender aktueller Beleg fehlt.")),
      assurance: assessment
        ? "assessment"
        : step.criterion.kind === "human_confirmation"
          ? "human"
          : "technical",
      evidence: resolutions.map((item) => item.evidence),
      next_action: status === "verified" || unavailable ? null : step.next_action,
    };
  });
  const complete =
    document.plan.completion_step_id !== null &&
    verified.has(document.plan.completion_step_id) &&
    steps.length > 0 &&
    steps.every((step) => ready.has(step.id));
  const status: PlaybookView["status"] = document.plan.cancelled
    ? "cancelled"
    : complete
      ? "completed"
      : steps.some((step) => step.status === "waiting_for_input")
        ? "waiting_for_input"
        : steps.some((step) => step.status === "blocked")
          ? "blocked"
          : ready.size === steps.length &&
              verified.size > 0 &&
              steps.every((step) => step.next_action === null)
            ? "prepared"
            : steps.some((step) => step.status === "in_progress" || ready.has(step.id))
              ? "in_progress"
              : "open";
  const deliveredAssessment = document.plan.steps.find(
    (step) => step.criterion.kind === "assessment" && step.criterion.result !== null,
  );
  const assessmentSummary =
    deliveredAssessment?.criterion.kind === "assessment"
      ? (() => {
          const result = deliveredAssessment.criterion.result?.replace(/\s+/g, " ").trim() ?? "";
          return result.length > 280 ? `${result.slice(0, 279).trimEnd()}…` : result;
        })()
      : null;
  const leadingBlocker =
    steps.find((step) => step.status === "waiting_for_input") ??
    steps.find((step) => step.status === "blocked") ??
    steps.find((step) => step.status === "stale") ??
    steps.find((step) => step.status === "in_progress");
  const blockerStep = leadingBlocker
    ? document.plan.steps.find((step) => step.id === leadingBlocker.id)
    : undefined;
  const blockerReason =
    blockerStep?.criterion.kind === "assessment" && blockerStep.criterion.result === null
      ? (blockerStep.note ?? blockerStep.criterion.description)
      : blockerStep?.criterion.kind === "human_confirmation"
        ? blockerStep.criterion.question
        : leadingBlocker?.reason;
  const actionableSummary = leadingBlocker
    ? `${leadingBlocker.label}: ${blockerReason}`
    : assessmentSummary
      ? assessmentSummary
      : en
        ? `${verified.size} checks evidenced; ${ready.size - verified.size} assessments available; ${steps.length - ready.size} steps open.`
        : `${verified.size} Prüfschritte belegt; ${ready.size - verified.size} Einschätzungen liegen vor; ${steps.length - ready.size} Schritte offen.`;
  if (inaccessible.size > 0) {
    return {
      id: document.id,
      title: en ? "Recheck playbook" : "Playbook erneut prüfen",
      goal: en
        ? "At least one piece of evidence is currently inaccessible."
        : "Mindestens ein Beleg ist derzeit nicht zugänglich.",
      revision,
      status: "blocked",
      summary: en
        ? "Saved details are hidden until permissions are checked again."
        : "Gespeicherte Angaben werden bis zur erneuten Berechtigungsprüfung ausgeblendet.",
      steps: steps.map((step) => ({
        ...step,
        label: en ? "Recheck step" : "Prüfschritt erneut prüfen",
        criterion: en
          ? "Recheck permission and evidence."
          : "Berechtigung und Beleg erneut prüfen.",
        status: "blocked",
        reason: en
          ? "At least one required piece of evidence is currently inaccessible."
          : "Mindestens ein benötigter Beleg ist derzeit nicht zugänglich.",
        evidence: [],
        next_action: null,
      })),
      next_action: null,
      completion: {
        status: "open",
        label: en
          ? "Check completion after rechecking permissions."
          : "Abschluss nach erneuter Berechtigungsprüfung prüfen.",
        reason: en
          ? "The saved details are not fully accessible right now."
          : "Die gespeicherten Angaben sind derzeit nicht vollständig zugänglich.",
      },
      updated_at: document.updated_at,
    };
  }
  return {
    id: document.id,
    title: document.plan.title,
    goal: document.plan.goal,
    revision,
    status,
    summary:
      status === "cancelled"
        ? en
          ? "Playbook ended."
          : "Playbook beendet."
        : status === "prepared"
          ? (assessmentSummary ??
            (en
              ? "A check or assessment is available. Subject-matter completion remains separate."
              : "Prüfung oder Einschätzung liegt vor. Der fachliche Abschluss bleibt separat."))
          : actionableSummary,
    steps,
    next_action: document.plan.cancelled
      ? null
      : (steps.find((step) => step.status !== "verified" && step.next_action)?.next_action ?? null),
    completion: {
      status: complete && !document.plan.cancelled ? "verified" : "open",
      label:
        document.plan.steps.find((step) => step.id === document.plan.completion_step_id)?.criterion
          .kind === "human_confirmation"
          ? complete && !document.plan.cancelled
            ? en
              ? "The explicitly named response has been confirmed by a person."
              : "Die ausdrücklich benannte Rückmeldung ist menschlich bestätigt."
            : en
              ? "The explicitly named human response is still required."
              : "Die ausdrücklich benannte menschliche Rückmeldung ist noch erforderlich."
          : document.plan.completion_step_id
            ? complete && !document.plan.cancelled
              ? en
                ? "The required new successful run is evidenced."
                : "Der verlangte neue erfolgreiche Lauf ist belegt."
              : en
                ? "Provide evidence of the required new successful run."
                : "Den verlangten neuen erfolgreichen Lauf nachweisen."
            : en
              ? "Provide results for further review."
              : "Ergebnisse zur weiteren Prüfung bereitstellen.",
      reason:
        complete && !document.plan.cancelled
          ? en
            ? "The stated checks are satisfied. This does not grant additional approval or execution rights."
            : "Die beschriebenen Prüfkriterien sind erfüllt. Daraus entsteht keine zusätzliche Freigabe oder Ausführungsberechtigung."
          : en
            ? "Assessments and prepared results are separate from technically verified effects."
            : "Einschätzungen und vorbereitete Ergebnisse sind von technisch bestätigten Wirkungen getrennt.",
    },
    updated_at: document.updated_at,
  };
}
