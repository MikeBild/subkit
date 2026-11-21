import { parseFileId } from "../../../api/files-schemas.ts";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import type { Executor } from "../../../db/client.ts";
import { resolvedFromRow } from "../../../files/resolver.ts";
import { findReadyFileByHash, listExecutionDataFileSizes } from "../../../files/service/index.ts";
import { loadStoredPackageArchive, previewPackageImport } from "../../../identity/index.ts";
import { getIntakeItemsForReview } from "../../../knowledge/index.ts";
import { getSkillCandidatesForReview } from "../../../skill-candidates/index.ts";
import { buildPendingOutputForTool } from "../../tool-policies.ts";
import type { ToolContext } from "../index.ts";
import { formatPackagePlanTitle } from "../package-portability.ts";
import { decodeWorkflowInputFile, WorkflowInputFileSchema } from "../workflow-file-input.ts";
import { taskGateCard } from "./task-gate-card.ts";

const GATE_BODY_EXCERPT_CHARS = 280;

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
  load(
    tenantId: string,
    ids: string[],
    db: Executor,
    locale: ToolContext["locale"],
  ): Promise<GateRecord[]>;
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

async function loadPackagePlans(
  tenantId: string,
  ids: string[],
  db: Executor,
  locale: ToolContext["locale"],
): Promise<GateRecord[]> {
  const records: GateRecord[] = [];
  for (const id of ids) {
    try {
      const stored = await loadStoredPackageArchive(db, tenantId, id);
      const plan = await previewPackageImport(db, tenantId, stored.bytes);
      records.push({
        id,
        title: formatPackagePlanTitle(stored.filename, plan, locale),
        status: "previewed",
      });
    } catch {}
  }
  return records;
}

function packageFileIds(args: Record<string, unknown>): string[] {
  const id = typeof args.file_id === "string" ? parseFileId(args.file_id) : null;
  return id ? [id] : [];
}

const SOURCES: Record<string, GateSubjectSource> = {
  apply_package_import: {
    ids: packageFileIds,
    load: loadPackagePlans,
    actionable: () => true,
  },
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
  locale?: ToolContext["locale"],
): Promise<GateCard | null> {
  const source = SOURCES[tool];
  if (!source) return null;
  const ids = source.ids(args);
  const rows = await source.load(
    tenantId,
    ids.filter((id) => UUID_RE.test(id)),
    db,
    locale,
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

interface PreparedGate {
  args: Record<string, unknown>;
  pending_output: Record<string, unknown> | null;
  execution_data_transfer?: true;
}

function referencedFileIds(value: unknown, found: Set<string>, depth = 0): void {
  if (depth > 32 || found.size > 64 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) referencedFileIds(item, found, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if ((key === "$file" || key === "id") && typeof item === "string") {
      const fileId = parseFileId(item);
      if (fileId && UUID_RE.test(fileId)) found.add(fileId);
    } else referencedFileIds(item, found, depth + 1);
  }
}

function declaredPartBytes(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const parts = (value as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return 0;
  return parts.reduce<number>((total, part) => {
    const bytes = (part as { bytes?: unknown } | null)?.bytes;
    return typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? total + bytes : total;
  }, 0);
}

async function inputFileContent(
  args: Record<string, unknown>,
  tenantId: string,
  db: Executor,
): Promise<{ inputFileId: string; content: Record<string, unknown> } | null> {
  const source = WorkflowInputFileSchema.safeParse(args.input_file);
  if (!source.success) return null;
  const inputFileId = parseFileId(source.data.id);
  if (!inputFileId) return null;
  const file = await findReadyFileByHash(db, tenantId, inputFileId, source.data.sha256);
  if (!file) return null;
  try {
    return {
      inputFileId,
      content: await decodeWorkflowInputFile(resolvedFromRow(file), source.data.sha256),
    };
  } catch {
    return null;
  }
}

export async function executionDataTransfer(
  args: Record<string, unknown>,
  tenantId: string,
  db: Executor,
): Promise<{ size_bytes: number } | null> {
  const ids = new Set<string>();
  referencedFileIds(args, ids);
  if (ids.size === 0) return null;
  const inputFile = await inputFileContent(args, tenantId, db);
  if (inputFile) {
    ids.delete(inputFile.inputFileId);
    referencedFileIds(inputFile.content, ids);
  }
  const declaredBytes = declaredPartBytes(inputFile?.content ?? args.input ?? args);
  const rows = await listExecutionDataFileSizes(db, tenantId, [...ids]);
  if (rows.length === 0) return null;
  const sizes = new Map(rows.map((row) => [row.id, row.size_bytes]));
  const fileBytes = [...sizes.values()].reduce((total, size) => total + size, 0);
  return { size_bytes: Math.max(declaredBytes, fileBytes) };
}

export async function prepareGate(
  tool: string,
  args: Record<string, unknown>,
  tenantId: string,
  db: Executor,
  locale?: ToolContext["locale"],
  principal?: ResolvedPrincipal | null,
): Promise<PreparedGate> {
  const transfer = tool === "run_workflow" ? await executionDataTransfer(args, tenantId, db) : null;
  if (transfer) {
    return {
      args,
      pending_output: {
        ...(buildPendingOutputForTool(tool, args) ?? {}),
        execution_data_transfer: { size_bytes: transfer.size_bytes },
      },
      execution_data_transfer: true,
    };
  }
  const card = await resolveGateSubjects(tool, args, tenantId, db, locale);
  const base =
    (await taskGateCard(tool, args, tenantId, db, principal)) ??
    buildPendingOutputForTool(tool, args);
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
