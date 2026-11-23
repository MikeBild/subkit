import type { TranslationKey } from "@/lib/i18n";
import { sameJsonValue } from "@/lib/json-value";

export type ChangeKind = "added" | "removed" | "changed";

export interface StepOperation {
  index: number;
  path: string;
  kind: ChangeKind;
  before: unknown;
  after: unknown;
}

export interface ChangeSentence {
  key: TranslationKey;
  params: Record<string, string>;
}

export interface ReviewChange {
  index: number;
  sentence: string;
  before: string | null;
  after: string | null;
  preview: string | null;
}

export type SelectionScope = "all" | "some" | "none";

export interface ChangeTestResult {
  ok: boolean;
  error: string | null;
  digest: string | null;
}

export interface TestedSelection {
  key: string;
  result: ChangeTestResult;
}

const VALUE_LIMIT = 80;

const FIELD_KEYS: Readonly<Record<string, TranslationKey>> = {
  url: "changeReview.field.url",
  path: "changeReview.field.url",
  method: "changeReview.field.method",
  body: "changeReview.field.body",
  data_selector: "changeReview.field.dataSelector",
  expression: "changeReview.field.expression",
  connector: "changeReview.field.connector",
  timeout_ms: "changeReview.field.timeout",
  retry: "changeReview.field.retry",
  output_schema: "changeReview.field.outputSchema",
};

const GROUP_KEYS: Readonly<Record<string, TranslationKey>> = {
  headers: "changeReview.field.header",
  query: "changeReview.field.query",
  params: "changeReview.field.query",
  body: "changeReview.field.bodyField",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAt(source: unknown, path: string): unknown {
  if (path === "") return source;
  return path
    .split(".")
    .reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), source);
}

function changedLeafPaths(before: unknown, after: unknown, prefix: string): string[] {
  if (sameJsonValue(before, after)) return [];
  const left = before === undefined && isRecord(after) && prefix ? {} : before;
  const right = after === undefined && isRecord(before) && prefix ? {} : after;
  if (!isRecord(left) || !isRecord(right)) return [prefix];
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  if (keys.length === 0) return [prefix];
  return keys.flatMap((key) =>
    changedLeafPaths(left[key], right[key], prefix ? `${prefix}.${key}` : key),
  );
}

export function stepOperations(
  before: unknown,
  after: unknown,
  paths?: readonly string[] | null,
): StepOperation[] {
  const listed = paths?.length ? [...paths] : changedLeafPaths(before, after, "");
  return listed.map((path, index) => {
    const left = valueAt(before, path);
    const right = valueAt(after, path);
    return {
      index,
      path,
      kind: left === undefined ? "added" : right === undefined ? "removed" : "changed",
      before: left,
      after: right,
    };
  });
}

function shown(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function short(value: unknown): string | null {
  if (value === undefined || (value !== null && typeof value === "object")) return null;
  const text = shown(value);
  return text.includes("\n") || text.length > VALUE_LIMIT ? null : text;
}

export function operationField(
  path: string,
  translate: (key: TranslationKey, params?: Record<string, string>) => string,
): string {
  if (path === "") return translate("changeReview.field.step");
  const [head = "", ...rest] = path.split(".");
  const group = rest.length > 0 ? GROUP_KEYS[head] : undefined;
  if (group) return translate(group, { name: rest.join(".") });
  const known = FIELD_KEYS[head];
  if (known && rest.length === 0) return translate(known);
  return translate("changeReview.field.other", { name: path });
}

export function operationSentence(
  operation: Pick<StepOperation, "path" | "kind" | "before" | "after">,
  translate: (key: TranslationKey, params?: Record<string, string>) => string,
): ChangeSentence {
  const field = operationField(operation.path, translate);
  const before = short(operation.before);
  const after = short(operation.after);
  if (operation.kind === "removed")
    return { key: "changeReview.sentence.removed", params: { field } };
  if (operation.kind === "added")
    return after === null
      ? { key: "changeReview.sentence.added", params: { field } }
      : { key: "changeReview.sentence.addedValue", params: { field, after } };
  return before === null || after === null
    ? { key: "changeReview.sentence.changed", params: { field } }
    : { key: "changeReview.sentence.changedValue", params: { field, before, after } };
}

export function stepReviewChanges(
  operations: readonly StepOperation[],
  translate: (key: TranslationKey, params?: Record<string, string>) => string,
): ReviewChange[] {
  return operations.map((operation) => {
    const sentence = operationSentence(operation, translate);
    const inline = sentence.params.before !== undefined || sentence.params.after !== undefined;
    return {
      index: operation.index,
      sentence: translate(sentence.key, sentence.params),
      before: inline || operation.before === undefined ? null : shown(operation.before),
      after: inline || operation.after === undefined ? null : shown(operation.after),
      preview: null,
    };
  });
}

export function promptReviewChanges(
  diffs: readonly { label: string; preview?: string | undefined }[],
): ReviewChange[] {
  return diffs.map((diff, index) => ({
    index,
    sentence: diff.label,
    before: null,
    after: null,
    preview: diff.preview?.trim() ? diff.preview : null,
  }));
}

export function selectAll(total: number): ReadonlySet<number> {
  return new Set(Array.from({ length: total }, (_, index) => index));
}

export function toggleSelection(
  selection: ReadonlySet<number>,
  index: number,
): ReadonlySet<number> {
  const next = new Set(selection);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  return next;
}

export function acceptedIndices(selection: ReadonlySet<number>, total: number): number[] {
  return [...selection]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < total)
    .sort((a, b) => a - b);
}

export function selectionScope(selection: ReadonlySet<number>, total: number): SelectionScope {
  const count = acceptedIndices(selection, total).length;
  return count === 0 ? "none" : count === total ? "all" : "some";
}

export function selectionKey(selection: ReadonlySet<number>, total: number): string {
  return acceptedIndices(selection, total).join(",");
}

export interface ChatApprovalOutput {
  confirmed: boolean;
  partial?: boolean;
  approved_indices?: number[];
}

export function chatApprovalOutput(
  selection: ReadonlySet<number>,
  total: number,
): ChatApprovalOutput {
  const approved = acceptedIndices(selection, total);
  if (approved.length === 0) return { confirmed: false };
  return { confirmed: true, partial: approved.length < total, approved_indices: approved };
}

export function acceptedOperations(
  selection: ReadonlySet<number>,
  total: number,
): number[] | undefined {
  return selectionScope(selection, total) === "some"
    ? acceptedIndices(selection, total)
    : undefined;
}

function withValueAt(source: unknown, keys: readonly string[], value: unknown): unknown {
  const [head, ...rest] = keys;
  if (head === undefined) return value;
  const base = isRecord(source) ? { ...source } : {};
  const next = withValueAt(base[head], rest, value);
  if (next === undefined) delete base[head];
  else base[head] = next;
  return base;
}

export function applyAccepted(
  before: unknown,
  operations: readonly StepOperation[],
  accepted: readonly number[],
): unknown {
  const chosen = new Set(accepted);
  return operations
    .filter((operation) => chosen.has(operation.index))
    .reduce<unknown>(
      (current, operation) =>
        operation.path === ""
          ? operation.after
          : withValueAt(current, operation.path.split("."), operation.after),
      before,
    );
}

export function withPatchedStep(
  steps: readonly unknown[],
  stepId: string,
  patched: unknown,
): unknown[] | null {
  let found = false;
  const next = steps.map((step) => {
    if (isRecord(step) && step.id === stepId) {
      found = true;
      return patched;
    }
    return step;
  });
  return found ? next : null;
}

export function acceptBlockedKey(input: {
  scope: SelectionScope;
  key: string;
  tested: TestedSelection | null;
  digestRequired: boolean;
}): TranslationKey | null {
  if (input.scope === "none") return "changeReview.blocked.none";
  if (!input.digestRequired || input.scope === "all") return null;
  if (input.tested?.key !== input.key) return "changeReview.blocked.testFirst";
  return input.tested.result.digest ? null : "changeReview.blocked.testFailed";
}

export function testedFor(tested: TestedSelection | null, key: string): ChangeTestResult | null {
  return tested?.key === key ? tested.result : null;
}

export function acceptDigest(input: {
  scope: SelectionScope;
  key: string;
  tested: TestedSelection | null;
  fullDigest: string | null | undefined;
}): string | null {
  if (input.scope === "none") return null;
  if (input.scope === "all") return input.fullDigest ?? null;
  return testedFor(input.tested, input.key)?.digest ?? null;
}
