import type {
  DomainBranchStep,
  DomainLoopStep,
  DomainParallelStep,
  DomainStepDef,
  DomainWorkflowDef,
} from "../domain-types.ts";

export interface StepEdge {
  from: string;
  to: string;
  reason:
    | "scope_placeholder"
    | "jsonata_scope"
    | "jsonata_bare"
    | "js_scope"
    | "data_selector"
    | "branch_arm"
    | "parallel_branch"
    | "loop_body";
}

interface StepDag {
  step_ids: ReadonlyArray<string>;
  edges: ReadonlyArray<StepEdge>;
  adjacency: ReadonlyMap<string, ReadonlyArray<string>>;
}

export interface CycleReport {
  has_cycle: boolean;
  cycles: ReadonlyArray<{
    nodes: ReadonlyArray<string>;
    reasons: ReadonlyArray<StepEdge["reason"]>;
  }>;
}

const SCOPE_PLACEHOLDER_RE = /\$\{\s*scope\.([a-zA-Z_][\w-]*)/g;
const JSONATA_SCOPE_RE = /\$scope\.([a-zA-Z_][\w-]*)/g;
const BARE_PATH_RE = /(?:^|[^\w$.])([a-zA-Z_][\w]*)\./g;
const JS_SCOPE_RE = /(?:^|[^\w$.])(?:input\.)?(?:scope|sourceData)\.([a-zA-Z_][\w]*)/g;

function collectStepReferences(
  step: DomainStepDef,
  knownIds: ReadonlySet<string>,
): Array<{ ref: string; reason: StepEdge["reason"] }> {
  const refs: Array<{ ref: string; reason: StepEdge["reason"] }> = [];
  const seen = new Set<string>();

  function add(ref: string, reason: StepEdge["reason"]): void {
    if (!knownIds.has(ref)) return;
    const key = `${ref}:${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ ref, reason });
  }

  function scanString(s: string, bare = true): void {
    SCOPE_PLACEHOLDER_RE.lastIndex = 0;
    JSONATA_SCOPE_RE.lastIndex = 0;
    JS_SCOPE_RE.lastIndex = 0;
    BARE_PATH_RE.lastIndex = 0;
    for (let m = SCOPE_PLACEHOLDER_RE.exec(s); m !== null; m = SCOPE_PLACEHOLDER_RE.exec(s)) {
      add(m[1]!, "scope_placeholder");
    }
    for (let m = JSONATA_SCOPE_RE.exec(s); m !== null; m = JSONATA_SCOPE_RE.exec(s)) {
      add(m[1]!, "jsonata_scope");
    }
    for (let m = JS_SCOPE_RE.exec(s); m !== null; m = JS_SCOPE_RE.exec(s)) {
      add(m[1]!, "js_scope");
    }
    if (!bare) return;
    for (let m = BARE_PATH_RE.exec(s); m !== null; m = BARE_PATH_RE.exec(s)) {
      add(m[1]!, "jsonata_bare");
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

  if (step.kind === "transform" && (step.language ?? "javascript") === "javascript") {
    const { expression, ...rest } = step;
    if (typeof expression === "string") scanString(expression, false);
    walk(rest);
  } else {
    walk(step);
  }

  if (typeof step.data_selector === "string") {
    const ds = step.data_selector;
    for (const id of knownIds) {
      if (id === step.id) continue;
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(^|[^\\w-])${escaped}(\\.|$|[^\\w-])`);
      if (re.test(ds)) {
        add(id, "data_selector");
      }
    }
  }

  return refs;
}

function collectContainmentEdges(step: DomainStepDef, knownIds: ReadonlySet<string>): StepEdge[] {
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
    const b: DomainBranchStep = step;
    addEdges(b.then_steps, "branch_arm");
    addEdges(b.else_steps ?? [], "branch_arm");
  } else if (step.kind === "parallel") {
    const p: DomainParallelStep = step;
    for (const branch of p.branches) {
      addEdges(branch, "parallel_branch");
    }
  } else if (step.kind === "loop") {
    const l: DomainLoopStep = step;
    addEdges(l.body, "loop_body");
  }
  return edges;
}

export function buildStepDag(def: Pick<DomainWorkflowDef, "steps">): StepDag {
  const stepIds = def.steps.map((s) => s.id);
  const knownIds = new Set(stepIds);

  const edges: StepEdge[] = [];
  for (const step of def.steps) {
    for (const ref of collectStepReferences(step, knownIds)) {
      edges.push({ from: step.id, to: ref.ref, reason: ref.reason });
    }
    edges.push(...collectContainmentEdges(step, knownIds));
  }

  const adjacency = new Map<string, string[]>();
  for (const id of stepIds) adjacency.set(id, []);
  const seenPair = new Set<string>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from)!;
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

export function detectCycles(dag: StepDag): CycleReport {
  const selfLoops: CycleReport["cycles"][number][] = [];
  for (const e of dag.edges) {
    if (e.from === e.to) {
      selfLoops.push({ nodes: [e.from], reasons: [e.reason] });
    }
  }

  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  // Stryker disable next-line ArrayDeclaration: EQ-DAG-STACK: unreachable initial sentinel below every DFS root
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
    const reasons: StepEdge["reason"][] = [];
    for (let i = 0; i < scc.length; i++) {
      const a = scc[i]!;
      const b = scc[(i + 1) % scc.length]!;
      const edge = dag.edges.find((e) => e.from === a && e.to === b);
      reasons.push(edge?.reason ?? "scope_placeholder");
    }
    cycles.push({ nodes: scc, reasons });
  }

  return {
    has_cycle: cycles.length > 0,
    cycles,
  };
}

export function topoSort(dag: StepDag): string[] {
  const inDegree = new Map<string, number>();
  for (const id of dag.step_ids) inDegree.set(id, 0);
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
      const minimumOrder = Math.min(a, b);
      if (a === b) best = [best, r].sort()[0]!;
      else if (minimumOrder === a) best = r;
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

export function renderCycleReport(report: CycleReport): string {
  if (!report.has_cycle) return "";
  const lines = report.cycles.map((c) => {
    const path = [...c.nodes, c.nodes[0]!].join(" → ");
    const reasons = c.reasons.length > 0 ? ` (via ${c.reasons.join(" / ")})` : "";
    return path + reasons;
  });
  return `cycles: ${lines.join("; ")}`;
}
