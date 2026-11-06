import type { components } from "@cli-core/engine-api/openapi";

export type WorkflowSpec = components["schemas"]["WorkflowSpec"];
export type WorkflowSpecOrigin = components["schemas"]["WorkflowSpecOrigin"];
type SpecDraft = components["schemas"]["WorkflowDraft"];

export type SpecState = "missing" | "unconfirmed" | "confirmed";

export interface SpecForm {
  goal: string;
  inputs: string;
  outputs: string;
  channel: string;
  destination: string;
  questions: string;
}

export function specState(spec: WorkflowSpec | null | undefined): SpecState {
  if (!spec) return "missing";
  return spec.origin === "person" && spec.goal ? "confirmed" : "unconfirmed";
}

export function specCanConfirm(spec: WorkflowSpec | null | undefined): boolean {
  return Boolean(spec?.goal) && specState(spec) !== "confirmed";
}

export function emptySpec(): WorkflowSpec {
  return {
    goal: null,
    inputs: [],
    outputs: [],
    delivery: null,
    conventions_applied: [],
    evidence: [],
    open_questions: [],
    origin: "person",
  };
}

function fieldLines(fields: WorkflowSpec["inputs"]): string {
  return fields
    .map((field) => (field.description ? `${field.name}: ${field.description}` : field.name))
    .join("\n");
}

export function specForm(spec: WorkflowSpec | null | undefined): SpecForm {
  return {
    goal: spec?.goal ?? "",
    inputs: fieldLines(spec?.inputs ?? []),
    outputs: fieldLines(spec?.outputs ?? []),
    channel: spec?.delivery?.channel ?? "",
    destination: spec?.delivery?.destination ?? "",
    questions: (spec?.open_questions ?? []).join("\n"),
  };
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseFields(text: string): WorkflowSpec["inputs"] {
  return lines(text).map((line) => {
    const cut = line.indexOf(":");
    if (cut <= 0) return { name: line };
    const name = line.slice(0, cut).trim();
    const description = line.slice(cut + 1).trim();
    return description ? { name, description } : { name };
  });
}

export function specFromForm(base: WorkflowSpec | null | undefined, form: SpecForm): WorkflowSpec {
  const start = base ?? emptySpec();
  const goal = form.goal.trim();
  const channel = form.channel.trim();
  const destination = form.destination.trim();
  return {
    ...start,
    goal: goal || null,
    inputs: parseFields(form.inputs),
    outputs: parseFields(form.outputs),
    delivery: channel ? { channel, ...(destination ? { destination } : {}) } : null,
    open_questions: lines(form.questions),
  };
}

export function specFormChanged(base: WorkflowSpec | null | undefined, form: SpecForm): boolean {
  return JSON.stringify(specFromForm(base, form)) !== JSON.stringify(base ?? emptySpec());
}

export function specFormValid(form: SpecForm): boolean {
  const longest = Math.max(
    form.goal.trim().length,
    ...lines(form.questions).map((line) => line.length),
    ...lines(form.inputs).map((line) => line.length),
    ...lines(form.outputs).map((line) => line.length),
  );
  return longest <= 2000 && lines(form.questions).length <= 50;
}

export function confirmedSpec(spec: WorkflowSpec): WorkflowSpec {
  return { ...spec, origin: "person" };
}

export function specSaveBody(draft: SpecDraft, spec: WorkflowSpec) {
  return {
    definition: draft.definition,
    expected_draft_version_id: draft.version_id,
    expected_current_version_id: draft.current_version_id,
    spec,
  };
}
