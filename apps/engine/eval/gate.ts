import { createHash } from "node:crypto";
import { z } from "zod";

export type GateKind = "offline" | "live";

const ProofSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  proven_at: z.string().min(1),
});

const GateSchema = z.object({
  offline: z.record(z.string(), ProofSchema),
  live: z.record(z.string(), ProofSchema),
});

export type GateProof = z.infer<typeof ProofSchema>;
export type GateFile = z.infer<typeof GateSchema>;

export const EMPTY_GATE: GateFile = { offline: {}, live: {} };

export interface GateStatus {
  changed: string[];
  removed: string[];
  unproven: string[];
}

export interface GateFinding {
  kind: GateKind;
  status: GateStatus;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function sha256(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part.length}:${part}`);
  return hash.digest("hex");
}

export function offlineFingerprint(fixture: unknown, validatorSource: string): string {
  return sha256(["offline", canonicalJson(fixture), validatorSource]);
}

export function promptFingerprint(sources: Array<{ path: string; content: string }>): string {
  const sorted = [...sources].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(sorted.flatMap((s) => [s.path, s.content]));
}

export function liveFingerprint(spec: unknown, prompt: string): string {
  return sha256(["live", canonicalJson(spec), prompt]);
}

export function parseGate(raw: string | null): GateFile {
  if (raw === null) return EMPTY_GATE;
  return GateSchema.parse(JSON.parse(raw));
}

export function renderGate(gate: GateFile): string {
  const sortedProofs = (proofs: Record<string, GateProof>) =>
    Object.fromEntries(
      Object.keys(proofs)
        .sort()
        .map((id) => [id, proofs[id]]),
    );
  return `${JSON.stringify({ offline: sortedProofs(gate.offline), live: sortedProofs(gate.live) }, null, 2)}\n`;
}

export function gateStatus(
  proofs: Record<string, GateProof>,
  current: Record<string, string>,
): GateStatus {
  const changed: string[] = [];
  const unproven: string[] = [];
  for (const [id, hash] of Object.entries(current)) {
    const proof = proofs[id];
    if (!proof) unproven.push(id);
    else if (proof.hash !== hash) changed.push(id);
  }
  const removed = Object.keys(proofs).filter((id) => !(id in current));
  return { changed: changed.sort(), removed: removed.sort(), unproven: unproven.sort() };
}

export function gateBlocks(status: GateStatus): boolean {
  return status.changed.length > 0 || status.removed.length > 0;
}

export function recordProofs(
  gate: GateFile,
  kind: GateKind,
  current: Record<string, string>,
  passed: ReadonlySet<string>,
  at: string,
): GateFile {
  const previous = gate[kind];
  const next: Record<string, GateProof> = {};
  for (const [id, hash] of Object.entries(current)) {
    const proof = previous[id];
    if (passed.has(id)) {
      next[id] = proof && proof.hash === hash ? proof : { hash, proven_at: at };
    } else if (proof) {
      next[id] = proof;
    }
  }
  return { ...gate, [kind]: next };
}

export function describeGate(findings: GateFinding[]): string[] {
  const lines: string[] = [];
  const hint: Record<GateKind, string> = {
    offline: "bun run eval baseline",
    live: "bun run eval live",
  };
  for (const { kind, status } of findings) {
    for (const id of status.changed) {
      lines.push(`${kind} ${id}: changed after its last proven run — re-prove with ${hint[kind]}`);
    }
    for (const id of status.removed) {
      lines.push(`${kind} ${id}: proven case no longer exists — prune with ${hint[kind]}`);
    }
  }
  return lines;
}
