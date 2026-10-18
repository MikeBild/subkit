import { and, asc, eq, inArray } from "drizzle-orm";
import { redactLearning } from "../agent/sessions.ts";
import type { Actor } from "../audit/actor.ts";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db, Executor } from "../db/client.ts";
import { skillCandidateEvidence, skillCandidates } from "../db/schema/skills.ts";
import { createSessionIntakeItem, DOMAIN_TAG_PREFIX } from "../knowledge/index.ts";
import { referencesKeyMaterialPath, scrubString } from "../logging/scrub-secrets.ts";
import { LEARNING_PATTERN_KINDS } from "./types.ts";

const CUTOVER_REQUEST_SOURCE = "migration";
const EXCERPT_MAX_CHARS = 2_000;

const SECTIONS = [
  ["pitfalls", "Pitfalls"],
  ["best_practices", "Best practices"],
  ["examples", "Examples"],
  ["doc_refs", "References"],
] as const;

type CandidateRow = typeof skillCandidates.$inferSelect;
type EvidenceRow = typeof skillCandidateEvidence.$inferSelect;

export interface LearningCutoverReport {
  collected: number;
  dropped: number;
}

export interface CutoverSession {
  agent: string;
  session_id: string;
  repo: string | null;
  excerpt: string;
  captured_at: Date;
}

function sectionEntries(examples: unknown, key: string): string[] {
  if (!examples || typeof examples !== "object") return [];
  const entries = (examples as Record<string, unknown>)[key];
  return Array.isArray(entries)
    ? entries.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function learningCandidateBody(candidate: Pick<CandidateRow, "body" | "examples">): string {
  return SECTIONS.reduce((body, [key, label]) => {
    const entries = sectionEntries(candidate.examples, key);
    if (entries.length === 0) return body;
    return `${body}\n\n${label}:\n${entries.map((entry) => `- ${entry}`).join("\n")}`;
  }, candidate.body.trimEnd());
}

function matchOf(summary: string, pattern: RegExp): string | null {
  return pattern.exec(summary)?.[1] ?? null;
}

export function cutoverSessionOf(
  candidate: Pick<CandidateRow, "id" | "title" | "created_at">,
  evidence: Pick<EvidenceRow, "id" | "evidence_type" | "summary" | "captured_at"> | null,
): CutoverSession {
  if (!evidence)
    return {
      agent: "session",
      session_id: `skill-candidate:${candidate.id}`,
      repo: null,
      excerpt: candidate.title,
      captured_at: candidate.created_at,
    };
  const summary = evidence.summary;
  const agent =
    matchOf(summary, /agent=(\S+)/) ??
    (summary.startsWith("explicit save_learning")
      ? "save_learning"
      : evidence.evidence_type === "conversation"
        ? "create_skill"
        : "session");
  return {
    agent,
    session_id:
      matchOf(summary, /session=(\S+)/) ??
      matchOf(summary, /conversation=([^)\s]+)/) ??
      `skill-candidate-evidence:${evidence.id}`,
    repo: matchOf(summary, /repo=(\S+)/),
    excerpt: summary,
    captured_at: evidence.captured_at,
  };
}

function proposerOf(candidate: CandidateRow): Actor | null {
  if (candidate.proposed_by_user_id) return { kind: "user", id: candidate.proposed_by_user_id };
  if (candidate.proposed_by_system_account_id)
    return { kind: "system_account", id: candidate.proposed_by_system_account_id };
  return null;
}

function domainsOf(tags: readonly string[]): string[] {
  return tags
    .filter((tag) => tag.startsWith(DOMAIN_TAG_PREFIX) && tag.length > DOMAIN_TAG_PREFIX.length)
    .map((tag) => tag.slice(DOMAIN_TAG_PREFIX.length));
}

async function supersede(
  tx: Executor,
  candidate: CandidateRow,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx
    .update(skillCandidates)
    .set({ status: "superseded", updated_at: new Date() })
    .where(
      and(eq(skillCandidates.tenant_id, candidate.tenant_id), eq(skillCandidates.id, candidate.id)),
    );
  await auditAwait(
    {
      tenant_id: candidate.tenant_id,
      actor_type: "system",
      action: AuditAction.SKILL_CANDIDATE_SUPERSEDED,
      resource_type: "skill_candidate",
      resource_id: candidate.id,
      result: "success",
      metadata: { ...metadata, request_source: CUTOVER_REQUEST_SOURCE },
    },
    tx,
  );
}

async function cutOverCandidate(
  db: Db,
  ref: { id: string; tenant_id: string },
): Promise<"collected" | "dropped" | "skipped"> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(skillCandidates)
      .where(and(eq(skillCandidates.tenant_id, ref.tenant_id), eq(skillCandidates.id, ref.id)))
      .limit(1)
      .for("update");
    if (candidate?.status !== "proposed") return "skipped";
    // tenant-filter:exempt — skill_candidate_evidence has no tenant_id column; the candidate above is tenant-checked
    const evidence = await tx
      .select()
      .from(skillCandidateEvidence)
      .where(eq(skillCandidateEvidence.skill_candidate_id, candidate.id))
      .orderBy(asc(skillCandidateEvidence.captured_at), asc(skillCandidateEvidence.id));
    const sessions = (evidence.length > 0 ? evidence : [null]).map((row) =>
      cutoverSessionOf(candidate, row),
    );
    const redacted = redactLearning({
      title: candidate.title,
      body: learningCandidateBody(candidate),
      pitfalls: [],
    });
    if (redacted.kind === "dropped" || sessions.some((s) => referencesKeyMaterialPath(s.excerpt))) {
      await supersede(tx, candidate, { reason: "dropped_by_redaction" });
      return "dropped";
    }
    const domains = domainsOf(candidate.tags);
    let item_id: string | null = null;
    for (const session of sessions) {
      const result = await createSessionIntakeItem(
        {
          tenant_id: candidate.tenant_id,
          actor: proposerOf(candidate),
          session: {
            agent: session.agent,
            session_id: session.session_id,
            repo: session.repo,
            domains,
            evidence_excerpt: scrubString(session.excerpt).slice(0, EXCERPT_MAX_CHARS),
          },
          title: redacted.title,
          body: redacted.body,
          captured_at: session.captured_at.toISOString(),
          learning: {
            kind: candidate.pattern_kind === "knowledge_learning" ? "fact" : "practice",
            scope: candidate.scope,
            ...(candidate.connector_id ? { connector_id: candidate.connector_id } : {}),
            ...(candidate.workflow_id ? { workflow_id: candidate.workflow_id } : {}),
            tags: candidate.tags,
          },
          request_source: CUTOVER_REQUEST_SOURCE,
        },
        tx,
      );
      item_id ??= result.item.id;
    }
    await supersede(tx, candidate, { reason: "collected_in_intake", intake_item_id: item_id });
    return "collected";
  });
}

export async function cutOverLearningCandidates(db: Db): Promise<LearningCutoverReport> {
  // tenant-filter:exempt — the boot cutover moves every tenant's open learning candidates
  const open = await db
    .select({ id: skillCandidates.id, tenant_id: skillCandidates.tenant_id })
    .from(skillCandidates)
    .where(
      and(
        eq(skillCandidates.status, "proposed"),
        inArray(skillCandidates.pattern_kind, [...LEARNING_PATTERN_KINDS]),
      ),
    )
    .orderBy(asc(skillCandidates.created_at), asc(skillCandidates.id));
  const report: LearningCutoverReport = { collected: 0, dropped: 0 };
  for (const ref of open) {
    const outcome = await cutOverCandidate(db, ref);
    if (outcome !== "skipped") report[outcome] += 1;
  }
  return report;
}
