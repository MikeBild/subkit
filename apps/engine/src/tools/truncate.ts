import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../logging/index.ts";
import { summarizeScopeShape } from "../workflows/scope-shape.ts";

const MAX_JSON_CHARS = 8000;
const MAX_ARRAY_LEN = 20;
const MAX_NESTED_ARRAY_LEN = 10;
const MAX_STEP_PREVIEW_CHARS = 1500;

const SHAPE_STUB_MIN_CHARS = 1024;

const MAX_PERSISTED_JSON_CHARS = 256_000;

const RAW_REF_TTL_MS = 30 * 60_000;
const RAW_REF_MAX_ENTRIES = 512;

interface RawEntry {
  value: unknown;
  expires_at: number;
  scope: RawResultScope | null;
}

export interface RawResultScope {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
}

const rawResultScope = new AsyncLocalStorage<RawResultScope>();

export function withRawResultScope<T>(scope: RawResultScope, operation: () => T): T {
  return rawResultScope.run(scope, operation);
}

function sameRawResultScope(left: RawResultScope | null, right: RawResultScope | null): boolean {
  return (
    left?.tenant_id === right?.tenant_id &&
    left?.conversation_id === right?.conversation_id &&
    left?.actor_id === right?.actor_id
  );
}

const rawStore = new Map<string, RawEntry>();

function storeRaw(refId: string, value: unknown): void {
  const now = Date.now();
  rawStore.set(refId, {
    value,
    expires_at: now + RAW_REF_TTL_MS,
    scope: rawResultScope.getStore() ?? null,
  });
  for (const [key, entry] of rawStore) {
    if (entry.expires_at < now) rawStore.delete(key);
  }
  while (rawStore.size > RAW_REF_MAX_ENTRIES) {
    const firstKey = rawStore.keys().next().value;
    if (firstKey === undefined) break;
    rawStore.delete(firstKey);
  }
}

export interface TruncatedOutput {
  truncated: boolean;
  data: unknown;
  raw_ref?: string;
  note?: string;
}

function truncateArray(arr: unknown[], cap: number): { arr: unknown[]; dropped: number } {
  if (arr.length <= cap) return { arr, dropped: 0 };
  return { arr: arr.slice(0, cap), dropped: arr.length - cap };
}

function approxJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateNode(value: unknown, arrayDepth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const cap = arrayDepth === 0 ? MAX_ARRAY_LEN : MAX_NESTED_ARRAY_LEN;
    const { arr, dropped } = truncateArray(value, cap);
    const mapped = arr.map((v) => truncateNode(v, arrayDepth + 1));
    if (dropped > 0) mapped.push({ _truncated: `+${dropped} more items (${value.length} total)` });
    return mapped;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = truncateNode(v, arrayDepth);
  }
  return out;
}

interface BranchHandle {
  size: number;
  shape: string;
  owner: object;
  node: object | null;
  replace: (marker: unknown) => void;
}

function computeJsonSizes(root: unknown): Map<object, number> {
  const sizes = new Map<object, number>();
  function sizeOf(node: unknown): number {
    if (node === null) return 4;
    const t = typeof node;
    if (t === "string" || t === "number" || t === "boolean") {
      const s = JSON.stringify(node);
      return s === undefined ? 4 : s.length;
    }
    if (t !== "object") return 4;
    const obj = node as object;
    const cached = sizes.get(obj);
    if (cached !== undefined) return cached;
    sizes.set(obj, 4);
    if (typeof (obj as { toJSON?: unknown }).toJSON === "function") {
      const exact = approxJsonLength(obj);
      sizes.set(obj, exact);
      return exact;
    }
    let total: number;
    if (Array.isArray(obj)) {
      total = 2;
      for (let i = 0; i < obj.length; i++) {
        if (i > 0) total += 1;
        total += sizeOf(obj[i]);
      }
    } else {
      total = 2;
      let first = true;
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
        if (!first) total += 1;
        total += JSON.stringify(k).length + 1 + sizeOf(v);
        first = false;
      }
    }
    sizes.set(obj, total);
    return total;
  }
  sizeOf(root);
  return sizes;
}

const SAMPLED_OUTPUT_PROTECTED_KEYS = new Set(["output", "output_note", "output_raw_ref"]);

const ALWAYS_PROTECTED_ROOT_KEYS = new Set(["judge", "warnings"]);

function collectHeaviestBranches(
  root: unknown,
  sizes: Map<object, number>,
  parents: Map<object, object>,
): BranchHandle[] {
  const handles: BranchHandle[] = [];
  const rootProtected =
    root !== null && typeof root === "object" && !Array.isArray(root)
      ? (root as Record<string, unknown>).output_sampled === true
        ? new Set([...SAMPLED_OUTPUT_PROTECTED_KEYS, ...ALWAYS_PROTECTED_ROOT_KEYS])
        : ALWAYS_PROTECTED_ROOT_KEYS
      : null;
  function walk(node: unknown, protectedKeys: Set<string> | null = null): void {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const child = node[i];
        if (child !== null && typeof child === "object") {
          parents.set(child, node);
          handles.push({
            size: sizes.get(child) ?? approxJsonLength(child),
            shape: summarizeScopeShape(child),
            owner: node,
            node: child,
            replace: (marker) => {
              node[i] = marker;
            },
          });
          walk(child);
        }
      }
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (protectedKeys?.has(k)) continue;
      const child = obj[k];
      if (child !== null && (typeof child === "object" || typeof child === "string")) {
        if (typeof child === "object") parents.set(child, obj);
        handles.push({
          size:
            typeof child === "object"
              ? (sizes.get(child) ?? approxJsonLength(child))
              : (JSON.stringify(child)?.length ?? 0),
          shape: summarizeScopeShape(child),
          owner: obj,
          node: typeof child === "object" ? child : null,
          replace: (marker) => {
            obj[k] = marker;
          },
        });
        if (typeof child === "object") walk(child);
      }
    }
  }
  walk(root, rootProtected);
  handles.sort((a, b) => b.size - a.size);
  return handles;
}

interface ShrinkResult {
  data: unknown;
  branchesOmitted: number;
  charsOmitted: number;
}

const SHRINK_VERIFY_MAX = 5;

function shrinkToCap(data: unknown, cap: number, rawRef: string): ShrinkResult {
  const sizes = computeJsonSizes(data);
  let current =
    data !== null && typeof data === "object"
      ? (sizes.get(data) ?? approxJsonLength(data))
      : approxJsonLength(data);
  if (current <= cap) return { data, branchesOmitted: 0, charsOmitted: 0 };
  const parents = new Map<object, object>();
  const handles = collectHeaviestBranches(data, sizes, parents);
  const replacedRoots = new Set<object>();
  const isDetached = (owner: object): boolean => {
    let node: object | undefined = owner;
    let hops = 0;
    while (node !== undefined && hops < 10_000) {
      if (replacedRoots.has(node)) return true;
      node = parents.get(node);
      hops += 1;
    }
    return false;
  };
  let branchesOmitted = 0;
  let charsOmitted = 0;
  let verifies = 0;
  for (const handle of handles) {
    if (current <= cap) {
      if (verifies >= SHRINK_VERIFY_MAX) break;
      verifies += 1;
      current = approxJsonLength(data);
      if (current <= cap) break;
    }
    if (handle.size < 64) continue;
    if (isDetached(handle.owner)) continue;
    const stub =
      handle.size >= SHAPE_STUB_MIN_CHARS
        ? `[omitted: ${handle.size} chars · shape: ${handle.shape} — get_raw_result(ref="${rawRef}")]`
        : `[omitted: ${handle.size} chars — get_raw_result(ref="${rawRef}")]`;
    if (handle.size <= stub.length + 16) continue;
    handle.replace(stub);
    if (handle.node !== null) replacedRoots.add(handle.node);
    branchesOmitted += 1;
    charsOmitted += handle.size;
    current -= handle.size - (stub.length + 2);
  }
  return { data, branchesOmitted, charsOmitted };
}

export function truncateForLlm(
  output: unknown,
  cap: number = MAX_JSON_CHARS,
  opts?: { store?: boolean },
): TruncatedOutput {
  const originalLen = approxJsonLength(output);
  if (originalLen <= cap) {
    return { truncated: false, data: output };
  }
  const refId = `raw_${crypto.randomUUID().slice(0, 8)}`;
  if (opts?.store !== false) storeRaw(refId, output);
  const pass1 = truncateNode(output);
  const { data: shortened, branchesOmitted, charsOmitted } = shrinkToCap(pass1, cap, refId);
  const shortenedLen = approxJsonLength(shortened);
  if (
    branchesOmitted > 0 &&
    shortened !== null &&
    typeof shortened === "object" &&
    !Array.isArray(shortened)
  ) {
    (shortened as Record<string, unknown>)._truncation_note =
      `${charsOmitted} chars in ${branchesOmitted} branch(es) omitted; fetch the omitted fields through get_raw_result(ref="${refId}") in bounded chunks`;
  }
  logger.debug({
    module: "conversation_tool",
    action: "truncate.applied",
    msg: "tool output truncated for LLM context",
    cap,
    original_chars: originalLen,
    shortened_chars: shortenedLen,
    branches_omitted: branchesOmitted,
    chars_omitted_in_branches: charsOmitted,
    raw_ref: refId,
  });
  return {
    truncated: true,
    data: shortened,
    raw_ref: refId,
    note: `tool output truncated from ${originalLen} → ${shortenedLen} chars; call get_raw_result(ref="${refId}") and follow its bounded field retrieval instructions`,
  };
}

export function withTruncationMarkers(truncated: TruncatedOutput): unknown {
  const markers = { _truncated: true, _raw_ref: truncated.raw_ref, _note: truncated.note };
  return truncated.data !== null &&
    typeof truncated.data === "object" &&
    !Array.isArray(truncated.data)
    ? { ...(truncated.data as Record<string, unknown>), ...markers }
    : { data: truncated.data, ...markers };
}

const PERSISTED_IDENTITY_KEYS = new Set([
  "id",
  "execution_id",
  "status",
  "kind",
  "ok",
  "error_code",
  "workflow_id",
  "version",
]);

const PERSIST_BOUND_PASSES = [
  { chars: 8_000, items: 200, keys: 1_000 },
  { chars: 2_000, items: 50, keys: 200 },
  { chars: 500, items: 10, keys: 50 },
  { chars: 100, items: 3, keys: 10 },
] as const;

type PersistBoundLimits = (typeof PERSIST_BOUND_PASSES)[number];

function boundLeaves(
  value: unknown,
  limits: PersistBoundLimits,
  rawRef: string,
  key?: string,
): unknown {
  const plain =
    value !== null &&
    typeof value === "object" &&
    typeof (value as { toJSON?: unknown }).toJSON === "function"
      ? (value as { toJSON: () => unknown }).toJSON()
      : value;
  if (typeof plain === "string") {
    if ((key !== undefined && PERSISTED_IDENTITY_KEYS.has(key)) || plain.length <= limits.chars)
      return plain;
    return `${plain.slice(0, limits.chars)}… [omitted: ${plain.length - limits.chars} chars — get_raw_result(ref="${rawRef}")]`;
  }
  if (plain === null || typeof plain !== "object") return plain;
  if (Array.isArray(plain)) {
    const kept = plain.slice(0, limits.items).map((entry) => boundLeaves(entry, limits, rawRef));
    return plain.length > limits.items
      ? [
          ...kept,
          `[omitted: ${plain.length - limits.items} of ${plain.length} items — get_raw_result(ref="${rawRef}")]`,
        ]
      : kept;
  }
  const entries = Object.entries(plain as Record<string, unknown>);
  const identity = entries.filter(([entryKey]) => PERSISTED_IDENTITY_KEYS.has(entryKey));
  const rest = entries.filter(([entryKey]) => !PERSISTED_IDENTITY_KEYS.has(entryKey));
  const bounded = Object.fromEntries(
    [...identity, ...rest.slice(0, limits.keys)].map(([entryKey, entry]) => [
      entryKey,
      boundLeaves(entry, limits, rawRef, entryKey),
    ]),
  );
  return rest.length > limits.keys
    ? { ...bounded, _omitted_keys: rest.length - limits.keys }
    : bounded;
}

function identityFields(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([key, entry]) =>
        PERSISTED_IDENTITY_KEYS.has(key) && (entry === null || typeof entry !== "object"),
    ),
  );
}

export function boundForPersistence(output: unknown, rawRef?: string): unknown {
  const originalLen = approxJsonLength(output);
  if (originalLen <= MAX_PERSISTED_JSON_CHARS) return output;
  const ref = rawRef ?? rememberRaw(output);
  let fitting: unknown;
  for (const limits of PERSIST_BOUND_PASSES) {
    const candidate = boundLeaves(output, limits, ref);
    if (approxJsonLength(candidate) > MAX_PERSISTED_JSON_CHARS) continue;
    fitting = candidate;
    break;
  }
  const data = fitting ?? identityFields(output);
  logger.info({
    module: "conversation_tool",
    action: "persist.output_bounded",
    msg: "tool output bounded before persistence",
    cap: MAX_PERSISTED_JSON_CHARS,
    original_chars: originalLen,
    bounded_chars: approxJsonLength(data),
    structure_kept: fitting !== undefined,
    raw_ref: ref,
  });
  return withTruncationMarkers({
    truncated: true,
    data,
    raw_ref: ref,
    note: `stored tool output bounded from ${originalLen} chars; call get_raw_result(ref="${ref}") and follow its bounded field retrieval instructions`,
  });
}

export function truncateStepPreviewForLlm(value: unknown): TruncatedOutput {
  return truncateForLlm(value, MAX_STEP_PREVIEW_CHARS);
}

const MAX_WORKFLOW_OUTPUT_CHARS = 5000;
const SAMPLE_STRING_HEAD_CHARS = 400;

interface SampledOutput {
  value: unknown;
  sampled: boolean;
  raw_ref?: string;
}

function sampleNode(value: unknown, maxItems: number): unknown {
  if (typeof value === "string") {
    return value.length > SAMPLE_STRING_HEAD_CHARS
      ? `${value.slice(0, SAMPLE_STRING_HEAD_CHARS)}… [${value.length - SAMPLE_STRING_HEAD_CHARS} more chars]`
      : value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map((v) => sampleNode(v, maxItems));
    if (value.length > maxItems) {
      items.push(`… sampled ${maxItems} of ${value.length} items`);
    }
    return items;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sampleNode(v, maxItems);
    }
    return out;
  }
  return value;
}

export function sampleWorkflowOutputForLlm(output: unknown): SampledOutput {
  if (output === null || output === undefined) return { value: output, sampled: false };
  let json: string;
  try {
    json = JSON.stringify(output) ?? String(output);
  } catch {
    return { value: output, sampled: false };
  }
  if (json.length <= MAX_WORKFLOW_OUTPUT_CHARS) return { value: output, sampled: false };
  const raw_ref = rememberRaw(output);
  for (const maxItems of [20, 10, 5, 3, 1]) {
    const sampled = sampleNode(output, maxItems);
    try {
      json = JSON.stringify(sampled) ?? "";
    } catch {
      break;
    }
    if (json.length <= MAX_WORKFLOW_OUTPUT_CHARS) {
      logger.debug({
        module: "conversation_tool",
        action: "truncate.output_sampled",
        msg: "workflow output sampled for LLM context",
        original_chars: JSON.stringify(output)?.length ?? 0,
        sampled_chars: json.length,
        max_items: maxItems,
        raw_ref,
      });
      return { value: sampled, sampled: true, raw_ref };
    }
  }
  return {
    value: `${json.slice(0, 2000)}… [output too large to inline]`,
    sampled: true,
    raw_ref,
  };
}

export function getRawResult(
  ref: string,
  scope: RawResultScope | null = rawResultScope.getStore() ?? null,
): unknown | undefined {
  const entry = rawStore.get(ref);
  if (entry === undefined) return undefined;
  if (!sameRawResultScope(entry.scope, scope)) return undefined;
  if (entry.expires_at < Date.now()) {
    rawStore.delete(ref);
    return undefined;
  }
  return entry.value;
}

export function clearRawStore(): void {
  rawStore.clear();
}

export function rememberRaw(value: unknown): string {
  const refId = `raw_${crypto.randomUUID().slice(0, 8)}`;
  storeRaw(refId, value);
  return refId;
}

export const TRUNCATE_INTERNALS = {
  MAX_JSON_CHARS,
  MAX_ARRAY_LEN,
  MAX_NESTED_ARRAY_LEN,
  MAX_STEP_PREVIEW_CHARS,
  MAX_PERSISTED_JSON_CHARS,
  RAW_REF_TTL_MS,
  RAW_REF_MAX_ENTRIES,
};
