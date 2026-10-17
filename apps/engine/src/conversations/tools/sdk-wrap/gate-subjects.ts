import type { Executor } from "../../../db/client.ts";
import { learningsTarget } from "../../../knowledge/index.ts";
import {
  getSkillCandidatesForReview,
  type SkillCandidateStatus,
} from "../../../skill-candidates/index.ts";
import { buildPendingOutputForTool } from "../../tool-policies.ts";

export const GATE_BODY_EXCERPT_CHARS = 280;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GateSubject {
  id: string;
  title: string | null;
  status: SkillCandidateStatus | "not_found";
}

export type GateTarget =
  | { kind: "skill_draft" }
  | { kind: "knowledge"; knowledge_source_name: string; knowledge_source_slug: string };

export interface GateCard {
  subjects: GateSubject[];
  target?: GateTarget;
  body_excerpt?: string;
  review_digest?: string;
}

function requestedIds(tool: string, args: Record<string, unknown>): string[] | null {
  if (tool === "approve_skill_candidate") {
    return typeof args.candidate_id === "string" ? [args.candidate_id] : [];
  }
  if (tool === "reject_skill_candidate") {
    const ids = Array.isArray(args.candidate_ids) ? args.candidate_ids : [];
    return [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  }
  return null;
}

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > GATE_BODY_EXCERPT_CHARS
    ? `${flat.slice(0, GATE_BODY_EXCERPT_CHARS - 1)}…`
    : flat;
}

export async function resolveGateSubjects(
  tool: string,
  args: Record<string, unknown>,
  tenantId: string,
  db: Executor,
): Promise<GateCard | null> {
  const ids = requestedIds(tool, args);
  if (ids === null) return null;
  const lookup = ids.filter((id) => UUID_RE.test(id));
  const rows = await getSkillCandidatesForReview(tenantId, lookup, db);
  const byId = new Map(rows.map((row) => [row.id.toLowerCase(), row]));
  const subjects: GateSubject[] = ids.map((id) => {
    const row = byId.get(id.toLowerCase());
    return row
      ? { id, title: row.title, status: row.status }
      : { id, title: null, status: "not_found" };
  });
  if (tool !== "approve_skill_candidate") return { subjects };
  const row = ids[0] ? byId.get(ids[0].toLowerCase()) : undefined;
  if (!row) return { subjects };
  const knowledge = row.pattern_kind === "knowledge_learning" ? learningsTarget(row.tags) : null;
  return {
    subjects,
    target: knowledge
      ? {
          kind: "knowledge",
          knowledge_source_name: knowledge.name,
          knowledge_source_slug: knowledge.slug,
        }
      : { kind: "skill_draft" },
    body_excerpt: excerpt(row.body),
    review_digest: row.review_digest,
  };
}

export function unresolvedGateSubjects(card: GateCard): {
  not_found: string[];
  already_decided: string[];
} {
  return {
    not_found: card.subjects.filter((s) => s.status === "not_found").map((s) => s.id),
    already_decided: card.subjects
      .filter((s) => s.status !== "not_found" && s.status !== "proposed")
      .map((s) => s.id),
  };
}

export interface PreparedGate {
  args: Record<string, unknown>;
  pending_output: Record<string, unknown> | null;
}

export async function prepareGate(
  tool: string,
  args: Record<string, unknown>,
  tenantId: string,
  db: Executor,
): Promise<PreparedGate> {
  const card = await resolveGateSubjects(tool, args, tenantId, db);
  const base = buildPendingOutputForTool(tool, args);
  if (!card) return { args, pending_output: base };
  const { review_digest, ...shown } = card;
  return {
    args: review_digest ? { ...args, expected_review_digest: review_digest } : args,
    pending_output: { ...(base ?? {}), ...shown },
  };
}
