import { z } from "@hono/zod-openapi";
import type { DriverName } from "../connectors/types.ts";

export const DiscoveryRunStatusSchema = z.enum([
  "pending",
  "analyzing",
  "synthesizing",
  "completed",
  "failed",
]);
export const DiscoveryArtifactKindSchema = z.enum([
  "connector",
  "skill",
  "knowledge_source",
  "capability_gap",
]);
export const DiscoveryArtifactStatusSchema = z.enum([
  "proposed",
  "approved",
  "rejected",
  "superseded",
]);

export type DiscoveryRunStatus = z.infer<typeof DiscoveryRunStatusSchema>;
export type DiscoveryArtifactKind = z.infer<typeof DiscoveryArtifactKindSchema>;
export type DiscoveryArtifactStatus = z.infer<typeof DiscoveryArtifactStatusSchema>;

export const DiscoveryRunSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    conversation_id: z.string().nullable(),
    status: DiscoveryRunStatusSchema,
    label: z.string().nullable(),
    file_count: z.number().int(),
    files_analyzed: z.number().int(),
    artifact_count: z.number().int(),
    token_usage: z.object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    }),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("DiscoveryRun");

export type DiscoveryRunView = z.infer<typeof DiscoveryRunSchema>;

export const DiscoveryArtifactSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    run_id: z.string(),
    kind: DiscoveryArtifactKindSchema,
    status: DiscoveryArtifactStatusSchema,
    title: z.string(),
    description: z.string().nullable(),
    draft: z.record(z.string(), z.unknown()),
    evidence: z.object({
      file_ids: z.array(z.string()),
      excerpts: z.array(
        z.object({
          file_id: z.string(),
          filename: z.string(),
          text: z.string(),
        }),
      ),
    }),
    confidence: z.number().int().nullable(),
    materialized_id: z.string().nullable(),
    materialized_type: z.string().nullable(),
    rejection_reason: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("DiscoveryArtifact");

export type DiscoveryArtifactView = z.infer<typeof DiscoveryArtifactSchema>;

export interface ConnectorDraft {
  name: string;
  slug?: string;
  driver: DriverName;
  base_url?: string;
  dsn?: string;
  auth_type: string;
  detection_signal: string;
}

export interface SkillDraft {
  scope: "global" | "connector" | "workflow";
  title: string;
  body: string;
  examples: string[];
  best_practices: string[];
  pitfalls: string[];
  related_connector_slug?: string;
}

export interface KnowledgeDraft {
  category: "runbook" | "architecture" | "glossary" | "reference" | "other";
  summary: string;
}

export interface DiscoveredArtifact {
  kind: DiscoveryArtifactKind;
  title: string;
  description: string;
  draft: ConnectorDraft | SkillDraft | KnowledgeDraft;
  evidence: Array<{ text: string }>;
  confidence: number;
}

export interface CreateDiscoveryRunParams {
  tenant_id: string;
  conversation_id?: string;
  label?: string;
  files: Array<{
    buffer: Buffer | Uint8Array | string;
    filename: string;
    mime?: string;
  }>;
  actor_id: string | null;
  archive_file_id?: string;
}

export interface ListDiscoveryRunsParams {
  tenant_id: string;
  status?: DiscoveryRunStatus;
  limit?: number;
  offset?: number;
}

export interface ListDiscoveryArtifactsParams {
  tenant_id: string;
  run_id: string;
  kind?: DiscoveryArtifactKind;
  status?: DiscoveryArtifactStatus;
  limit?: number;
  offset?: number;
}
