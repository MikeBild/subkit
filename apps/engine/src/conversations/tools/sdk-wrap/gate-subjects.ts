import type { Executor } from "../../../db/client.ts";
import { getIntakeItemsForReview } from "../../../knowledge/index.ts";
import { getSkillCandidatesForReview } from "../../../skill-candidates/index.ts";
import { buildPendingOutputForTool } from "../../tool-policies.ts";

export const GATE_BODY_EXCERPT_CHARS = 280;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GateSubject {
  id: string;
  title: string | null;
  status: string;
  body_excerpt?: string;
}

export type GateTarget = { kind: "skill_draft" };

export interface GateCard {
  subjects: GateSubject[];
  target?: GateTarget;
  body_excerpt?: string;
  review_digest?: string;
  review_digests?: Record<string, string>;
}

interface GateRecord {
  id: string;
  title: string;
  status: string;
  body?: string;
  review_digest?: string;
}

interface GateSubjectSource {
  ids(args: Record<string, unknown>): string[];
  load(tenantId: string, ids: string[], db: Executor): Promise<GateRecord[]>;
  actionable(status: string): boolean;
  reviewed?: true;
}

function uniqueIds(value: unknown): string[] {
  const ids = Array.isArray(value) ? value : [];
  return [...new Set(ids.filter((id): id is string => typeof id === "string"))];
}

async function loadCandidates(
  tenantId: string,
  ids: string[],
  db: Executor,
): Promise<GateRecord[]> {
  return (await getSkillCandidatesForReview(tenantId, ids, db)).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    body: row.body,
    review_digest: row.review_digest,
  }));
}

async function loadIntakeItems(
  tenantId: string,
  ids: string[],
  db: Executor,
): Promise<GateRecord[]> {
  return (await getIntakeItemsForReview(tenantId, ids, db)).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.state,
  }));
}

const SOURCES: Record<string, GateSubjectSource> = {
  approve_skill_candidate: {
    ids: (args) =>
      uniqueIds([
        ...(Array.isArray(args.candidate_ids) ? args.candidate_ids : []),
        ...(typeof args.candidate_id === "string" ? [args.candidate_id] : []),
      ]),
    load: loadCandidates,
    actionable: (status) => status === "proposed",
    reviewed: true,
  },
  reject_skill_candidate: {
    ids: (args) => uniqueIds(args.candidate_ids),
    load: loadCandidates,
    actionable: (status) => status === "proposed",
  },
  discard_intake_items: {
    ids: (args) => uniqueIds(args.item_ids),
    load: loadIntakeItems,
    actionable: (status) => status === "collected" || status === "reviewing",
  },
};

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
  const source = SOURCES[tool];
  if (!source) return null;
  const ids = source.ids(args);
  const rows = await source.load(
    tenantId,
    ids.filter((id) => UUID_RE.test(id)),
    db,
  );
  const byId = new Map(rows.map((row) => [row.id.toLowerCase(), row]));
  const subjects: GateSubject[] = ids.map((id) => {
    const row = byId.get(id.toLowerCase());
    return row
      ? { id, title: row.title, status: row.status }
      : { id, title: null, status: "not_found" };
  });
  if (!source.reviewed) return { subjects };
  if (ids.length > 1) {
    const review_digests: Record<string, string> = {};
    const reviewed = subjects.map((subject) => {
      const row = byId.get(subject.id.toLowerCase());
      if (row?.review_digest !== undefined) review_digests[subject.id] = row.review_digest;
      return row?.body !== undefined ? { ...subject, body_excerpt: excerpt(row.body) } : subject;
    });
    return {
      subjects: reviewed,
      target: { kind: "skill_draft" },
      ...(Object.keys(review_digests).length > 0 ? { review_digests } : {}),
    };
  }
  const row = ids[0] ? byId.get(ids[0].toLowerCase()) : undefined;
  if (!row) return { subjects };
  return {
    subjects,
    target: { kind: "skill_draft" },
    ...(row.body !== undefined ? { body_excerpt: excerpt(row.body) } : {}),
    ...(row.review_digest !== undefined ? { review_digest: row.review_digest } : {}),
  };
}

export function unresolvedGateSubjects(
  tool: string,
  card: GateCard,
): {
  not_found: string[];
  already_decided: string[];
} {
  const actionable = SOURCES[tool]?.actionable ?? (() => false);
  return {
    not_found: card.subjects.filter((s) => s.status === "not_found").map((s) => s.id),
    already_decided: card.subjects
      .filter((s) => s.status !== "not_found" && !actionable(s.status))
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
  const { review_digest, review_digests, ...shown } = card;
  return {
    args: {
      ...args,
      ...(review_digest ? { expected_review_digest: review_digest } : {}),
      ...(review_digests ? { expected_review_digests: review_digests } : {}),
    },
    pending_output: { ...(base ?? {}), ...shown },
  };
}
