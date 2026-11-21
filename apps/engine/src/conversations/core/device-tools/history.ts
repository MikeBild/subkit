import type { DeviceToolSpec } from "./catalog.ts";
import { type DeviceToolFailure, stoppedOutput } from "./result.ts";
import {
  bag,
  browserRefKey,
  computerRefSnapshot,
  type ElementFacts,
  parseBrowserSnapshot,
  parseWindowSnapshot,
  refFreshness,
} from "./snapshot.ts";
import type { FilledValue } from "./step.ts";

export interface DeviceStepRecord {
  readonly tool: string;
  readonly device_id: string;
  readonly origin: string | null;
  readonly snapshot_id: string | null;
  readonly window_id: string | null;
  readonly state_hash: string | null;
  readonly app: string | null;
  readonly refs: Readonly<Record<string, ElementFacts>> | null;
  readonly filled: readonly FilledValue[];
}

export interface Resolved {
  readonly element: ElementFacts | null;
  readonly page_origin: string | null;
  readonly app: string | null;
  readonly window_id: string | null;
  readonly state_hash: string | null;
  readonly ref: string | null;
}

type Input = Record<string, unknown>;

function text(input: Input, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

function needsBrowserRef(spec: DeviceToolSpec, input: Input): boolean {
  if (spec.name === "browser_fill") return true;
  if (spec.name === "browser_press") return input.action === "click";
  return spec.name === "browser_extract" && text(input, "ref") !== null;
}

function snapshotOf(
  latest: DeviceStepRecord | null,
  tool: "browser_snapshot" | "computer_snapshot",
  requested: string | null,
): DeviceStepRecord | DeviceToolFailure {
  const freshness = refFreshness(latest, tool, requested);
  return freshness.fresh ? freshness.snapshot : stoppedOutput(freshness.reason);
}

export function resolveRef(
  spec: DeviceToolSpec,
  input: Input,
  steps: readonly DeviceStepRecord[],
): Resolved | DeviceToolFailure {
  const latest = steps[0] ?? null;
  const empty: Resolved = {
    element: null,
    page_origin: latest?.origin ?? null,
    app: latest?.app ?? null,
    window_id: latest?.window_id ?? null,
    state_hash: null,
    ref: null,
  };
  if (spec.capability === "browser") {
    if (!needsBrowserRef(spec, input)) return empty;
    const page = snapshotOf(latest, "browser_snapshot", text(input, "snapshot_id"));
    if ("ok" in page) return page;
    const ref = browserRefKey(String(input.ref));
    const element = page.refs?.[ref];
    return element ? { ...empty, element, ref } : stoppedOutput("unknown_ref");
  }
  if (spec.ref === null) return empty;
  if (spec.name === "computer_key") {
    const window = snapshotOf(latest, "computer_snapshot", latest?.snapshot_id ?? null);
    if ("ok" in window) return window;
    if (window.window_id !== input.window_id) return stoppedOutput("other_snapshot");
    return { ...empty, state_hash: window.state_hash };
  }
  const ref = String(input.ref);
  const window = snapshotOf(latest, "computer_snapshot", computerRefSnapshot(ref));
  if ("ok" in window) return window;
  const element = window.refs?.[ref];
  return element
    ? { ...empty, element, ref, state_hash: window.state_hash }
    : stoppedOutput("unknown_ref");
}

const FILLING: ReadonlySet<string> = new Set([
  "browser_fill",
  "computer_type",
  "computer_set_value",
  "computer_select",
]);

export function filledBy(
  spec: DeviceToolSpec,
  input: Input,
  element: ElementFacts | null,
): FilledValue[] {
  if (!FILLING.has(spec.name)) return [];
  const field = element?.name ?? null;
  const values = Array.isArray(input.values)
    ? input.values.map(String)
    : [text(input, "text") ?? text(input, "value") ?? text(input, "option") ?? ""];
  return values.filter((value) => value.length > 0).map((value) => ({ field, value }));
}

export function stepRecord(
  p: { readonly tool: string; readonly device_id: string; readonly filled: readonly FilledValue[] },
  output: unknown,
  call_id: string,
): DeviceStepRecord {
  const step = bag(bag(output).step);
  const base: DeviceStepRecord = {
    tool: p.tool,
    device_id: p.device_id,
    origin: text(step, "origin"),
    snapshot_id: null,
    window_id: null,
    state_hash: null,
    app: null,
    refs: null,
    filled: p.filled,
  };
  if (p.tool === "browser_snapshot") {
    const page = parseBrowserSnapshot(output);
    return { ...base, origin: page.origin, snapshot_id: call_id, refs: page.refs };
  }
  if (p.tool !== "computer_snapshot") return base;
  const window = parseWindowSnapshot(output);
  return window
    ? {
        ...base,
        snapshot_id: window.snapshot_id,
        window_id: window.window_id,
        state_hash: window.state_hash,
        app: window.app,
        refs: window.refs,
      }
    : base;
}

export function sameElement(a: ElementFacts | null, b: ElementFacts | undefined): boolean {
  return a !== null && b !== undefined && a.role === b.role && a.name === b.name;
}
