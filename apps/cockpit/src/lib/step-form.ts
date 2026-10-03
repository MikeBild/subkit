/**
 * The step dialog's form (R16): a step as the fields a person fills in, and
 * back. Only the kinds a form can describe completely are edited this way —
 * a call to a connector, a transformation and a pause; any other kind keeps
 * its stored configuration.
 */
export type StepFormKind = "request" | "transform" | "wait";

export const STEP_FORM_KINDS: readonly StepFormKind[] = ["request", "transform", "wait"];

export const STEP_METHODS = ["GET", "POST", "PUT", "DELETE"] as const;
export type StepMethod = (typeof STEP_METHODS)[number];

export interface StepForm {
  name: string;
  kind: StepFormKind;
  connectorId: string;
  method: StepMethod;
  path: string;
  code: string;
  wait: string;
}

/** The transformation a new step starts with. */
export const DEFAULT_TRANSFORM = "return {\n  ...input,\n  checked: true,\n};";

type RecordValue = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Whether a stored step can be edited field by field. */
export function isFormKind(kind: unknown): kind is StepFormKind {
  return kind === "request" || kind === "transform" || kind === "wait";
}

/** "5 min", "30 s", "2 h" → milliseconds; null when it is no duration. */
export function parseDuration(text: string): number | null {
  const match = /^(\d+(?:[.,]\d+)?)\s*(s|sek|sec|min|m|h|std)?$/i.exec(text.trim());
  if (!match) return null;
  const amount = Number((match[1] ?? "").replace(",", "."));
  const unit = (match[2] ?? "min").toLowerCase();
  const factor = unit === "h" || unit === "std" ? 3_600_000 : unit.startsWith("s") ? 1_000 : 60_000;
  const ms = Math.round(amount * factor);
  return ms > 0 && ms <= 24 * 3_600_000 ? ms : null;
}

/** Milliseconds as the dialog writes them: whole hours, minutes, else seconds. */
export function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1_000)} s`;
}

/** The form a step opens with: the stored step's values, or a new step's. */
export function formFromStep(step: unknown, firstConnectorId: string): StepForm {
  const raw = step && typeof step === "object" ? (step as RecordValue) : {};
  const kind = isFormKind(raw.kind) ? raw.kind : "request";
  const method = STEP_METHODS.find((entry) => entry === raw.method) ?? "POST";
  return {
    name: str(raw.id),
    kind,
    connectorId: str(raw.connector_id) || firstConnectorId,
    method,
    path: str(raw.path),
    code: str(raw.expression) || DEFAULT_TRANSFORM,
    wait: typeof raw.duration_ms === "number" ? formatDuration(raw.duration_ms) : "5 min",
  };
}

export type StepFormError =
  | "nameMissing"
  | "nameInvalid"
  | "nameTaken"
  | "connectorMissing"
  | "pathInvalid"
  | "codeMissing"
  | "waitInvalid";

/**
 * The step the form describes, or what is wrong with it. An edited step
 * keeps every stored field the form does not show, as long as its kind
 * stays the same.
 */
export function stepFromForm(
  form: StepForm,
  previous: unknown,
  taken: readonly string[],
): { step: RecordValue } | { error: StepFormError } {
  const name = form.name.trim().toLowerCase().replace(/\s+/g, "-");
  if (!name) return { error: "nameMissing" };
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return { error: "nameInvalid" };
  if (taken.includes(name)) return { error: "nameTaken" };
  const old = previous && typeof previous === "object" ? (previous as RecordValue) : null;
  const base: RecordValue = old && old.kind === form.kind ? { ...old } : {};
  if (form.kind === "request") {
    if (!form.connectorId) return { error: "connectorMissing" };
    const path = form.path.trim();
    if (!path.startsWith("/")) return { error: "pathInvalid" };
    return {
      step: {
        ...base,
        id: name,
        kind: "request",
        connector_id: form.connectorId,
        method: form.method,
        path,
      },
    };
  }
  if (form.kind === "wait") {
    const ms = parseDuration(form.wait);
    if (ms === null) return { error: "waitInvalid" };
    return { step: { ...base, id: name, kind: "wait", duration_ms: ms } };
  }
  if (!form.code.trim()) return { error: "codeMissing" };
  return { step: { ...base, id: name, kind: "transform", expression: form.code } };
}
