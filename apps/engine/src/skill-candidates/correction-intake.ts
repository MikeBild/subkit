import { and, eq, inArray, sql } from "drizzle-orm";
import { redactLearning } from "../agent/sessions.ts";
import type { Actor } from "../audit/actor.ts";
import type { Db } from "../db/client.ts";
import { intakeItemEvidence, intakeItems } from "../db/schema/intake.ts";
import { ensureNamedSystemAccount } from "../identity/service.ts";
import { createSessionIntakeItem, normalizeIntakeTitle } from "../knowledge/index.ts";
import { log } from "../logging/logger.ts";
import { referencesKeyMaterialPath, scrubString } from "../logging/scrub-secrets.ts";
import { type CorrectionObservation, detectCorrectionPatterns } from "./detectors/index.ts";

export const CORRECTION_AGENT = "correction_pattern";
export const CORRECTION_COLLECTOR_NAME = "authoring-corrections";
const CORRECTION_REQUEST_SOURCE = "scheduler";
const EXCERPT_MAX_CHARS = 2_000;
const MAX_NEW_ITEMS_PER_PASS = 20;

export interface CorrectionIntakeReport {
  observed: number;
  collected: number;
  evidence_appended: number;
  dropped: number;
  deferred: number;
}

interface RedactedObservation {
  observation: CorrectionObservation;
  title: string;
  body: string;
  excerpt: string;
}

function redactObservation(observation: CorrectionObservation): RedactedObservation | null {
  const redacted = redactLearning({
    title: observation.title,
    body: observation.body,
    pitfalls: [],
  });
  if (redacted.kind === "dropped" || referencesKeyMaterialPath(observation.excerpt)) return null;
  return {
    observation,
    title: redacted.title,
    body: redacted.body,
    excerpt: scrubString(observation.excerpt).slice(0, EXCERPT_MAX_CHARS),
  };
}

function occurrenceKey(title: string, occurrence_id: string): string {
  return `${normalizeIntakeTitle(title)}\n${occurrence_id}`;
}

async function recordedOccurrences(
  tenant_id: string,
  occurrence_ids: string[],
  db: Db,
): Promise<Set<string>> {
  if (occurrence_ids.length === 0) return new Set();
  const rows = await db
    .select({
      title: intakeItems.title,
      original_title: sql<string | null>`${intakeItems.original_snapshot} ->> 'title'`,
      session_id: intakeItemEvidence.session_id,
    })
    .from(intakeItemEvidence)
    .innerJoin(
      intakeItems,
      and(eq(intakeItems.id, intakeItemEvidence.item_id), eq(intakeItems.tenant_id, tenant_id)),
    )
    .where(
      and(
        eq(intakeItemEvidence.tenant_id, tenant_id),
        eq(intakeItemEvidence.agent, CORRECTION_AGENT),
        inArray(intakeItemEvidence.session_id, occurrence_ids),
      ),
    );
  return new Set(
    rows.flatMap((row) => [
      occurrenceKey(row.title, row.session_id),
      ...(row.original_title ? [occurrenceKey(row.original_title, row.session_id)] : []),
    ]),
  );
}

async function correctionCollector(tenant_id: string, db: Db): Promise<Actor> {
  const account = await ensureNamedSystemAccount(
    {
      tenant_id,
      name: CORRECTION_COLLECTOR_NAME,
      description: "Collects authoring corrections into intake for review",
    },
    db,
  );
  return { kind: "system_account", id: account.id };
}

export async function collectCorrectionIntake(
  tenant_id: string,
  db: Db,
): Promise<CorrectionIntakeReport> {
  const observations = await detectCorrectionPatterns(tenant_id, db);
  const report: CorrectionIntakeReport = {
    observed: observations.length,
    collected: 0,
    evidence_appended: 0,
    dropped: 0,
    deferred: 0,
  };
  const pending = new Map<string, RedactedObservation>();
  for (const observation of observations) {
    const redacted = redactObservation(observation);
    if (!redacted) {
      report.dropped += 1;
      continue;
    }
    const key = occurrenceKey(redacted.title, observation.occurrence_id);
    if (!pending.has(key)) pending.set(key, redacted);
  }
  const recorded = await recordedOccurrences(
    tenant_id,
    [...new Set([...pending.values()].map((entry) => entry.observation.occurrence_id))],
    db,
  );
  const fresh = [...pending.entries()].filter(([key]) => !recorded.has(key));
  if (fresh.length === 0) return report;
  const collector = await correctionCollector(tenant_id, db);
  for (const [, entry] of fresh) {
    if (report.collected >= MAX_NEW_ITEMS_PER_PASS) {
      report.deferred += 1;
      continue;
    }
    const { observation } = entry;
    const result = await createSessionIntakeItem(
      {
        tenant_id,
        actor: collector,
        session: {
          agent: CORRECTION_AGENT,
          session_id: observation.occurrence_id,
          repo: null,
          domains: [],
          evidence_excerpt: entry.excerpt,
        },
        title: entry.title,
        body: entry.body,
        captured_at: observation.captured_at.toISOString(),
        learning: {
          kind: "practice",
          scope: observation.workflow_id ? "workflow" : "global",
          ...(observation.workflow_id ? { workflow_id: observation.workflow_id } : {}),
          tags: [`correction:${observation.kind}`],
        },
        request_source: CORRECTION_REQUEST_SOURCE,
      },
      db,
    );
    if (result.outcome === "created") report.collected += 1;
    else if (result.outcome === "evidence_appended") report.evidence_appended += 1;
  }
  log.info({
    module: "skill",
    action: "correction_intake.completed",
    msg: "authoring corrections collected into intake",
    tenant_id,
    ...report,
  });
  return report;
}
