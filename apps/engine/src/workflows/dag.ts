// Step dependency DAG — pure functions, no I/O. Built once per
// build_workflow / dry_run_workflow / edit_workflow_patch call so the
// engine can flag cycles before they reach runtime.
//
// The DAG mixes two edge kinds:
//   - data-flow: a step's expression / placeholder / data_selector
//                references another step's output (`${scope.<id>…}`,
//                `$scope.<id>`, `<id>.` prefix in JS data_selectors).
//   - control-flow containment: branch.then_steps / branch.else_steps,
//                parallel.branches[][], loop.body each list step IDs
//                that depend on the container step running first.
//
// Topological execution at runtime is a follow-up. For now the DAG
// powers cycle detection only — the linear runtime walk in engine.ts
// stays as the source of truth for ordering. Cycles, however, are
// rejected at authoring time with a typed `workflow_cycle_detected`
// error so a future topo-sort change can land without surprise.

import type { BranchStep, LoopStep, ParallelStep, StepDef, WorkflowDef } from "./types.ts";

export interface StepEdge {
  /** Step ID that depends on `to` */
  from: string;
  /** Step ID that must produce output before `from` runs */
  to: string;
  /** Why the edge exists — surfaces in cycle reports */
  reason:
    | "scope_placeholder"
    | "jsonata_scope"
    | "jsonata_bare"
    | "data_selector"
    | "branch_arm"
    | "parallel_branch"
    | "loop_body";
}

export interface StepDag {
  /** Step IDs in declaration order. */
  step_ids: ReadonlyArray<string>;
  /** Forward edges keyed by `from`. */
  edges: ReadonlyArray<StepEdge>;
  /** Adjacency map keyed by `from` step id, values are unique `to` ids. */
  adjacency: ReadonlyMap<string, ReadonlyArray<string>>;
}

export interface CycleReport {
  /** True when the DAG contains at least one cycle. */
  has_cycle: boolean;
  /** Each detected cycle, listed as the participating step IDs in order. */
  cycles: ReadonlyArray<{
    nodes: ReadonlyArray<string>;
    /** Why those edges exist — reasons[i] explains nodes[i] → nodes[(i+1) % len]. */
    reasons: ReadonlyArray<StepEdge["reason"]>;
  }>;
}

const SCOPE_PLACEHOLDER_RE = /\$\{\s*scope\.([a-zA-Z_][\w-]*)/g;
const JSONATA_SCOPE_RE = /\$scope\.([a-zA-Z_][\w-]*)/g;
// Bare-path JSONata reference: a leading identifier followed by a
// dot. Matches the same form `<step_id>.data` documented as
// equivalent to `$scope.<step_id>.data`. Filtered against the known
// step ids — this lets us detect cycles when the LLM authored a
// forward-ref via the bare form (which the JSONata regex above
// misses).
const BARE_PATH_RE = /(?:^|[^\w$.])([a-zA-Z_][\w]*)\./g;

/**
 * Walk every string field on a step config and collect the step IDs
 * it references via placeholder / JSONata syntax. Returns an array of
 * `{ ref, reason }` pairs in encounter order so the cycle report can
 * cite WHY an edge was added.
 */
function collectStepReferences(
  step: StepDef,
  knownIds: ReadonlySet<string>,
): Array<{ ref: string; reason: StepEdge["reason"] }> {
  const refs: Array<{ ref: string; reason: StepEdge["reason"] }> = [];
  const seen = new Set<string>();

  function add(ref: string, reason: StepEdge["reason"]): void {
    if (!knownIds.has(ref)) return;
    // Self-loops ARE valid cycle inputs — `id="a"` referencing
    // `$scope.a.data` is a 1-step cycle the detector should flag.
    const key = `${ref}:${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ ref, reason });
  }

  function scanString(s: string): void {
    SCOPE_PLACEHOLDER_RE.lastIndex = 0;
    JSONATA_SCOPE_RE.lastIndex = 0;
    BARE_PATH_RE.lastIndex = 0;
    for (let m = SCOPE_PLACEHOLDER_RE.exec(s); m !== null; m = SCOPE_PLACEHOLDER_RE.exec(s)) {
      add(m[1] ?? "", "scope_placeholder");
    }
    for (let m = JSONATA_SCOPE_RE.exec(s); m !== null; m = JSONATA_SCOPE_RE.exec(s)) {
      add(m[1] ?? "", "jsonata_scope");
    }
    // Bare-path edges are only added when the leading identifier
    // matches a KNOWN step id. The validator's bare-path detector
    // is more permissive (it flags unknown ids); for the DAG we
    // only care about real step→step edges that could form a cycle.
    for (let m = BARE_PATH_RE.exec(s); m !== null; m = BARE_PATH_RE.exec(s)) {
      const ref = m[1] ?? "";
      if (ref && knownIds.has(ref)) add(ref, "jsonata_bare");
    }
  }

  function walk(value: unknown): void {
    if (typeof value === "string") {
      scanString(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (value && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v);
    }
  }

  walk(step);

  // data_selector — JS expression. We can't statically evaluate, but
  // recognise `<id>.` prefix references heuristically. Conservative:
  // only count refs to known step IDs.
  if ("data_selector" in step && typeof step.data_selector === "string") {
    const ds = step.data_selector;
    for (const id of knownIds) {
      if (id === step.id) continue;
      // Match identifier followed by `.` or end. Word boundary on
      // both sides keeps `fetch_orders` from accidentally matching
      // `fetch`. Skip if already seen via JSONata regex above.
      const re = new RegExp(`(^|[^\\w-])${id}(\\.|$|[^\\w-])`);
      if (re.test(ds)) {
        add(id, "data_selector");
      }
    }
  }

  return refs;
}

/**
 * Add control-flow containment edges: contained steps depend on
 * their container. branch.then_steps / branch.else_steps depend on
 * the branch; parallel.branches[][] depend on the parallel; loop.body
 * depends on the loop. This means a contained step CANNOT precede its
 * container in topological order, even when it has no data-flow tie.
 *
 * Edge direction note: in this DAG, `from depends on to` (i.e. an
 * edge `a → b` means `a` runs AFTER `b`). So the containment edge
 * `child → container` correctly enforces "container runs first" via
 * topoSort. Don't flip the direction without also flipping topoSort's
 * in-degree accumulator.
 */
function collectContainmentEdges(step: StepDef, knownIds: ReadonlySet<string>): StepEdge[] {
  const edges: StepEdge[] = [];
  const containerId = step.id;

  function addEdges(ids: ReadonlyArray<string>, reason: StepEdge["reason"]): void {
    for (const childId of ids) {
      if (childId === containerId) continue;
      if (!knownIds.has(childId)) continue;
      edges.push({ from: childId, to: containerId, reason });
    }
  }

  if (step.kind === "branch") {
    const b = step as BranchStep;
    addEdges(b.then_steps ?? [], "branch_arm");
    addEdges(b.else_steps ?? [], "branch_arm");
  } else if (step.kind === "parallel") {
    const p = step as ParallelStep;
    for (const branch of p.branches ?? []) {
      addEdges(branch ?? [], "parallel_branch");
    }
  } else if (step.kind === "loop") {
    const l = step as LoopStep;
    addEdges(l.body ?? [], "loop_body");
  }
  return edges;
}

/**
 * Build the step dependency graph. Pure data — no I/O. Idempotent.
 *
 * Self-loops are recorded as edges (so cycle detection can flag them
 * uniformly). Forward refs are valid in the DAG; only cycles are
 * rejected. Containment edges always point from contained step to its
 * container, matching the runtime invariant that the container must
 * run before its arms / branches / body.
 */
export function buildStepDag(def: WorkflowDef): StepDag {
  const stepIds = def.steps.map((s) => s.id);
  const knownIds = new Set(stepIds);

  const edges: StepEdge[] = [];
  for (const step of def.steps) {
    // Data-flow edges from references in this step's config to the
    // referenced step. Self-references emit an edge id→id so cycle
    // detection catches them.
    for (const ref of collectStepReferences(step, knownIds)) {
      edges.push({ from: step.id, to: ref.ref, reason: ref.reason });
    }
    // Containment edges from contained steps back to this container.
    edges.push(...collectContainmentEdges(step, knownIds));
  }

  const adjacency = new Map<string, string[]>();
  for (const id of stepIds) adjacency.set(id, []);
  const seenPair = new Set<string>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from);
    if (!list) continue;
    const key = `${edge.from}->${edge.to}`;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    list.push(edge.to);
  }

  return {
    step_ids: stepIds,
    edges,
    adjacency,
  };
}

/**
 * Detect cycles via Tarjan's SCC. Any SCC of size > 1 is a cycle;
 * any self-loop (id → id) is a 1-step cycle. Returns the participating
 * IDs and the edge reasons so the typed error can cite both.
 */
export function detectCycles(dag: StepDag): CycleReport {
  // Self-loops first — cheap to spot, often the root cause.
  const selfLoops: CycleReport["cycles"][number][] = [];
  for (const e of dag.edges) {
    if (e.from === e.to) {
      selfLoops.push({ nodes: [e.from], reasons: [e.reason] });
    }
  }

  // Tarjan's SCC for everything else.
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const sccs: string[][] = [];

  function strongconnect(node: string): void {
    index.set(node, counter);
    lowlink.set(node, counter);
    counter++;
    stack.push(node);
    onStack.add(node);

    for (const next of dag.adjacency.get(node) ?? []) {
      if (next === node) continue; // self-loop, handled above
      if (!index.has(next)) {
        strongconnect(next);
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(next)!));
      } else if (onStack.has(next)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, index.get(next)!));
      }
    }

    if (lowlink.get(node) === index.get(node)) {
      const scc: string[] = [];
      while (true) {
        const w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
        if (w === node) break;
      }
      if (scc.length > 1) sccs.push(scc.reverse());
    }
  }

  for (const id of dag.step_ids) {
    if (!index.has(id)) strongconnect(id);
  }

  const cycles: CycleReport["cycles"][number][] = [...selfLoops];
  for (const scc of sccs) {
    // Build the reasons array by walking the cycle: nodes[i] → nodes[i+1]
    const nodeSet = new Set(scc);
    const reasons: StepEdge["reason"][] = [];
    for (let i = 0; i < scc.length; i++) {
      const a = scc[i]!;
      const b = scc[(i + 1) % scc.length]!;
      const edge = dag.edges.find((e) => e.from === a && e.to === b && nodeSet.has(b));
      reasons.push(edge?.reason ?? "scope_placeholder");
    }
    cycles.push({ nodes: scc, reasons });
  }

  return {
    has_cycle: cycles.length > 0,
    cycles,
  };
}

/**
 * Topological sort. Stable: ties between independent siblings are
 * broken by declaration order, then alphabetical. Throws if the DAG
 * contains a cycle — callers should run `detectCycles` first.
 */
export function topoSort(dag: StepDag): string[] {
  const inDegree = new Map<string, number>();
  for (const id of dag.step_ids) inDegree.set(id, 0);
  // Edges represent "from depends on to" → for topo we need "to comes
  // before from". Reverse the direction when counting in-degree.
  for (const e of dag.edges) {
    if (e.from === e.to) continue;
    inDegree.set(e.from, (inDegree.get(e.from) ?? 0) + 1);
  }

  const declOrder = new Map<string, number>();
  dag.step_ids.forEach((id, i) => {
    declOrder.set(id, i);
  });

  function pickReady(ready: ReadonlyArray<string>): string {
    let best = ready[0]!;
    for (const r of ready) {
      const a = declOrder.get(r) ?? Number.MAX_SAFE_INTEGER;
      const b = declOrder.get(best) ?? Number.MAX_SAFE_INTEGER;
      if (a < b || (a === b && r < best)) best = r;
    }
    return best;
  }

  const result: string[] = [];
  const ready: string[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) ready.push(id);

  while (ready.length > 0) {
    const next = pickReady(ready);
    const idx = ready.indexOf(next);
    ready.splice(idx, 1);
    result.push(next);

    for (const e of dag.edges) {
      if (e.to !== next) continue;
      const newDeg = (inDegree.get(e.from) ?? 0) - 1;
      inDegree.set(e.from, newDeg);
      if (newDeg === 0) ready.push(e.from);
    }
  }

  if (result.length !== dag.step_ids.length) {
    throw new Error(
      `topoSort: graph has a cycle — only sorted ${result.length} of ${dag.step_ids.length} nodes`,
    );
  }
  return result;
}

/**
 * Render a CycleReport as a one-line operator-readable string. Used
 * inside the typed `workflow_cycle_detected` error so the LLM /
 * operator can read the path without parsing the structured payload.
 */
export function renderCycleReport(report: CycleReport): string {
  if (!report.has_cycle) return "";
  const lines = report.cycles.map((c) => {
    const path = [...c.nodes, c.nodes[0]!].join(" → ");
    const reasons = c.reasons.length > 0 ? ` (via ${c.reasons.join(" / ")})` : "";
    return path + reasons;
  });
  return `cycles: ${lines.join("; ")}`;
}
