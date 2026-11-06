import { isLiteralSecretHeader, SECRET_MASK } from "@/lib/workflow-steps";

export type StepFormKind = "request" | "transform" | "wait" | "branch";

export const STEP_FORM_KINDS: readonly StepFormKind[] = ["request", "transform", "wait", "branch"];

export const STEP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type StepMethod = (typeof STEP_METHODS)[number];

export interface StepForm {
  name: string;
  kind: StepFormKind;
  connectorId: string;
  method: StepMethod;
  path: string;
  query: string;
  headers: string;
  body: string;
  code: string;
  wait: string;
  when: string;
  thenSteps: string[];
  elseSteps: string[];
}

const DEFAULT_TRANSFORM = "return {\n  ...input,\n  checked: true,\n};";

type RecordValue = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const record = (value: unknown): RecordValue | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : null;

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const pretty = (value: unknown): string =>
  value === undefined ? "" : JSON.stringify(value, null, 2);

const REQUEST_DRIVER_FIELDS = ["url", "sql", "graphql", "mcp", "s3"] as const;

function isFormKind(kind: unknown): kind is StepFormKind {
  return kind === "request" || kind === "transform" || kind === "wait" || kind === "branch";
}

export function isFormStep(step: unknown): boolean {
  const raw = record(step);
  if (!raw) return true;
  if (!isFormKind(raw.kind)) return false;
  if (raw.kind === "request") {
    if (REQUEST_DRIVER_FIELDS.some((field) => raw[field] !== undefined)) return false;
    if (raw.method !== undefined && !STEP_METHODS.some((method) => method === raw.method))
      return false;
    if (typeof raw.headers === "string") return false;
  }
  if (raw.kind === "transform" && raw.language !== undefined && raw.language !== "javascript")
    return false;
  return true;
}

export function stepKeyFromName(name: string, fallback: string, taken: readonly string[]): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || fallback;
  if (!taken.includes(base)) return base;
  let suffix = 2;
  while (taken.includes(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

export function parseDuration(text: string): number | null {
  const match = /^(\d+(?:[.,]\d+)?)\s*(s|sek|sec|min|m|h|std)?$/i.exec(text.trim());
  if (!match) return null;
  const amount = Number((match[1] ?? "").replace(",", "."));
  const unit = (match[2] ?? "min").toLowerCase();
  const factor = unit === "h" || unit === "std" ? 3_600_000 : unit.startsWith("s") ? 1_000 : 60_000;
  const ms = Math.round(amount * factor);
  return ms > 0 && ms <= 24 * 3_600_000 ? ms : null;
}

export function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1_000)} s`;
}

function formatHeaders(value: unknown): string {
  const headers = record(value);
  if (!headers) return "";
  return Object.entries(headers)
    .map(([name, content]) => {
      const shown = typeof content === "string" ? content : "";
      return `${name}: ${isLiteralSecretHeader(name, shown) ? SECRET_MASK : shown}`;
    })
    .join("\n");
}

function unmaskHeaders(
  headers: Record<string, string>,
  previous: unknown,
): Record<string, string> | null {
  const stored = record(previous) ?? {};
  const restored: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== SECRET_MASK) {
      restored[name] = value;
      continue;
    }
    const kept = Object.entries(stored).find(
      ([storedName, storedValue]) =>
        storedName.toLowerCase() === name.toLowerCase() && typeof storedValue === "string",
    );
    if (!kept) return null;
    restored[name] = kept[1] as string;
  }
  return restored;
}

export function parseHeaders(text: string): Record<string, string> | null {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    const name = line.slice(0, colon).trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return null;
    headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

export function formFromStep(step: unknown, firstConnectorId: string): StepForm {
  const raw = record(step) ?? {};
  const kind = isFormKind(raw.kind) ? raw.kind : "request";
  const method = STEP_METHODS.find((entry) => entry === raw.method) ?? "GET";
  return {
    name: str(raw.id),
    kind,
    connectorId: str(raw.connector_id) || firstConnectorId,
    method,
    path: str(raw.path),
    query: pretty(raw.query),
    headers: formatHeaders(raw.headers),
    body: pretty(raw.body),
    code: str(raw.expression) || DEFAULT_TRANSFORM,
    wait: typeof raw.duration_ms === "number" ? formatDuration(raw.duration_ms) : "5 min",
    when: str(raw.when),
    thenSteps: ids(raw.then_steps),
    elseSteps: ids(raw.else_steps),
  };
}

export type StepFormError =
  | "nameMissing"
  | "nameInvalid"
  | "nameTaken"
  | "connectorMissing"
  | "pathInvalid"
  | "queryInvalid"
  | "headersInvalid"
  | "bodyInvalid"
  | "codeMissing"
  | "waitInvalid"
  | "whenMissing"
  | "thenMissing"
  | "branchUnknownStep"
  | "branchOverlap";

export type StepFormField = keyof StepForm;

export const STEP_FORM_ERROR_FIELDS: Record<StepFormError, StepFormField> = {
  nameMissing: "name",
  nameInvalid: "name",
  nameTaken: "name",
  connectorMissing: "connectorId",
  pathInvalid: "path",
  queryInvalid: "query",
  headersInvalid: "headers",
  bodyInvalid: "body",
  codeMissing: "code",
  waitInvalid: "wait",
  whenMissing: "when",
  thenMissing: "thenSteps",
  branchUnknownStep: "thenSteps",
  branchOverlap: "elseSteps",
};

function parseJson(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

function parseQuery(text: string): { value: RecordValue | undefined } | null {
  if (!text.trim()) return { value: undefined };
  const parsed = parseJson(text);
  const query = record(parsed?.value);
  if (!query) return null;
  const scalar = Object.values(query).every(
    (value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean",
  );
  return scalar ? { value: query } : null;
}

function withOptional(step: RecordValue, field: string, value: unknown): RecordValue {
  const { [field]: _dropped, ...rest } = step;
  return value === undefined ? rest : { ...rest, [field]: value };
}

export function stepFromForm(
  form: StepForm,
  previous: unknown,
  taken: readonly string[],
): { step: RecordValue } | { error: StepFormError } {
  const name = form.name.trim().toLowerCase().replace(/\s+/g, "-");
  if (!name) return { error: "nameMissing" };
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return { error: "nameInvalid" };
  if (taken.includes(name)) return { error: "nameTaken" };
  const old = record(previous);
  const base: RecordValue = old && old.kind === form.kind ? { ...old } : {};
  if (form.kind === "request") {
    if (!form.connectorId) return { error: "connectorMissing" };
    const path = form.path.trim();
    if (!path.startsWith("/")) return { error: "pathInvalid" };
    const query = parseQuery(form.query);
    if (!query) return { error: "queryInvalid" };
    const parsedHeaders = parseHeaders(form.headers);
    const headers = parsedHeaders && unmaskHeaders(parsedHeaders, old?.headers);
    if (!headers) return { error: "headersInvalid" };
    const body = form.body.trim() ? parseJson(form.body) : { value: undefined };
    if (!body) return { error: "bodyInvalid" };
    let step: RecordValue = {
      ...base,
      id: name,
      kind: "request",
      connector_id: form.connectorId,
      method: form.method,
      path,
    };
    step = withOptional(step, "query", query.value);
    step = withOptional(step, "headers", Object.keys(headers).length > 0 ? headers : undefined);
    step = withOptional(step, "body", body.value);
    return { step };
  }
  if (form.kind === "wait") {
    const ms = parseDuration(form.wait);
    if (ms === null) return { error: "waitInvalid" };
    return { step: { ...base, id: name, kind: "wait", duration_ms: ms } };
  }
  if (form.kind === "branch") {
    const when = form.when.trim();
    if (!when) return { error: "whenMissing" };
    if (form.thenSteps.length === 0) return { error: "thenMissing" };
    const chosen = [...form.thenSteps, ...form.elseSteps];
    if (chosen.some((id) => id === name || !taken.includes(id)))
      return { error: "branchUnknownStep" };
    if (form.thenSteps.some((id) => form.elseSteps.includes(id))) return { error: "branchOverlap" };
    const step: RecordValue = {
      ...base,
      id: name,
      kind: "branch",
      when,
      then_steps: [...form.thenSteps],
    };
    return {
      step: withOptional(
        step,
        "else_steps",
        form.elseSteps.length > 0 ? [...form.elseSteps] : undefined,
      ),
    };
  }
  if (!form.code.trim()) return { error: "codeMissing" };
  return { step: { ...base, id: name, kind: "transform", expression: form.code } };
}
