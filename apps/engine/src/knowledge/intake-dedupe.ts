import { type Actor, AuditAction } from "../audit/index.ts";
import type { Executor } from "../db/index.ts";
import { embeddingsAvailable, embedTexts } from "../embeddings/index.ts";
import { errorFields, logger } from "../logging/index.ts";
import {
  absorbedReplay,
  INTAKE_SIMILARITY_CANDIDATES,
  type IntakeLearningTarget,
  mostSimilar,
  similarityText,
} from "./core/intake-dedupe.ts";
import { IntakeConflictError } from "./intake-errors.ts";
import { intakeItemView, recordIntakeAudit } from "./intake-rows.ts";
import type { IntakeItemView } from "./intake-types.ts";
import {
  absorbedRequestEvidence,
  insertIntakeEvidence,
  intakeRowById,
  intakeRowByRequestId,
  lockOpenIntakeDuplicate,
  recentOpenIntakeTexts,
} from "./persistence/intake-dedupe.ts";

const COLLECTED_EVIDENCE_CHARS = 1000;

export interface IntakeEmbedder {
  available(): Promise<boolean>;
  embed(texts: string[]): Promise<number[][]>;
}

export interface IntakeDedupeDeps {
  readonly embedder?: IntakeEmbedder;
}

const localEmbedder: IntakeEmbedder = {
  available: () => embeddingsAvailable(),
  embed: (texts) => embedTexts(texts),
};

export async function similarOpenIntakeItem(
  db: Executor,
  p: {
    tenant_id: string;
    target: IntakeLearningTarget | null;
    title: string;
    body: string;
    exclude_request_id?: string | undefined;
  },
  embedder: IntakeEmbedder = localEmbedder,
): Promise<string | null> {
  if (!(await embedder.available().catch(() => false))) return null;
  const candidates = await recentOpenIntakeTexts(db, {
    tenant_id: p.tenant_id,
    target: p.target,
    limit: INTAKE_SIMILARITY_CANDIDATES,
    exclude_request_id: p.exclude_request_id,
  });
  if (candidates.length === 0) return null;
  if (candidates.length === INTAKE_SIMILARITY_CANDIDATES)
    logger.info({
      module: "knowledge",
      action: "intake.dedupe.ceiling",
      msg: "intake similarity check compared only the newest open items",
      tenant_id: p.tenant_id,
      ceiling: INTAKE_SIMILARITY_CANDIDATES,
    });
  let vectors: number[][];
  try {
    vectors = await embedder.embed([
      similarityText(p.title, p.body),
      ...candidates.map((c) => similarityText(c.title, c.body)),
    ]);
  } catch (err) {
    logger.warn({
      module: "knowledge",
      action: "intake.dedupe.embedding_failed",
      msg: "intake similarity check skipped; the item is collected without it",
      tenant_id: p.tenant_id,
      ...errorFields(err),
    });
    return null;
  }
  const [vector, ...rest] = vectors;
  if (!vector || rest.length !== candidates.length) return null;
  return (
    mostSimilar(
      vector,
      candidates.map((c, i) => ({ id: c.id, vector: rest[i] })),
    )?.id ?? null
  );
}

export function collectedEvidenceExcerpt(source_url: string | undefined, body: string): string {
  const excerpt = body.trim().slice(0, COLLECTED_EVIDENCE_CHARS);
  return source_url ? `${source_url}\n\n${excerpt}`.trim() : excerpt || "-";
}

export async function appendToOpenDuplicate(
  tx: Executor,
  p: {
    tenant_id: string;
    actor: Actor;
    target: IntakeLearningTarget | null;
    source_url?: string | undefined;
    similar_id: string | null;
    agent: string;
    session_id: string;
    repo: string | null;
    excerpt: string;
    captured_at: string;
    request_source?: string | undefined;
  },
): Promise<IntakeItemView | null> {
  const found = await lockOpenIntakeDuplicate(tx, {
    tenant_id: p.tenant_id,
    target: p.target,
    source_url: p.source_url,
    similar_id: p.similar_id,
  });
  if (!found) return null;
  const appended = await insertIntakeEvidence(tx, {
    tenant_id: p.tenant_id,
    item_id: found.row.id,
    agent: p.agent,
    session_id: p.session_id,
    repo: p.repo,
    excerpt: p.excerpt,
    captured_at: p.captured_at,
    recorded_by: p.actor,
  });
  if (appended)
    await recordIntakeAudit(
      tx,
      p.tenant_id,
      p.actor,
      AuditAction.INTAKE_ITEM_EVIDENCE_APPENDED,
      "intake_item",
      found.row.id,
      {
        match: found.match,
        agent: p.agent,
        ...(p.request_source ? { request_source: p.request_source } : {}),
      },
    );
  return intakeItemView(found.row);
}

export async function intakeItemByRequestId(
  db: Executor,
  tenant_id: string,
  client_request_id: string,
): Promise<IntakeItemView | null> {
  const row = await intakeRowByRequestId(db, tenant_id, client_request_id);
  if (row) return intakeItemView(row);
  const [absorbed] = await absorbedRequestEvidence(db, tenant_id, client_request_id);
  const target = absorbed ? await intakeRowById(db, tenant_id, absorbed.item_id) : null;
  return target ? intakeItemView(target) : null;
}

export async function replayAbsorbedRequest(
  tx: Executor,
  p: { tenant_id: string; client_request_id: string; digest: string },
): Promise<IntakeItemView | null> {
  const decision = absorbedReplay(
    p.client_request_id,
    p.digest,
    await absorbedRequestEvidence(tx, p.tenant_id, p.client_request_id),
  );
  if (decision.kind === "none") return null;
  if (decision.kind === "conflict")
    throw new IntakeConflictError("item request id was already used with different content");
  const row = await intakeRowById(tx, p.tenant_id, decision.item_id);
  return row ? intakeItemView(row) : null;
}
