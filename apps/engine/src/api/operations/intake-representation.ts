import { z } from "@hono/zod-openapi";
import { CategorySchema } from "../catalog-metadata.ts";
import {
  IntakeAttachmentSchema,
  IntakeItemSnapshotSchema,
  IntakeProposalTargetSchema,
  IntakeTargetKindSchema,
} from "../intake-schemas.ts";

const SnapshotSchema = z
  .object({
    title: z.string().min(1).max(1_000).optional(),
    source_url: z.string().url().optional(),
    source_author: z.string().min(1).max(1_000).optional(),
    published_at: z.string().min(1).max(1_000).optional(),
    captured_at: z.string().datetime().optional(),
    body: z.string().min(1).max(2_000_000).optional(),
    origin: z.enum(["capture", "restored_draft"]).optional(),
  })
  .openapi("IntakeOriginalSnapshot");

export const DefaultCategorySchema = z
  .object({ category: CategorySchema })
  .openapi("IntakeDefaultCategory");

export const DefaultCategoryCheckSchema = z
  .object({ category: CategorySchema, can_collect: z.boolean() })
  .openapi("IntakeDefaultCategoryCheck");

export const ItemStateSchema = z.enum(["collected", "reviewing", "admitted", "discarded"]);

export const ItemSchema = z
  .object({
    id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    category: CategorySchema,
    client_request_id: z.string().uuid(),
    original_snapshot: IntakeItemSnapshotSchema,
    title: z.string(),
    body: z.string(),
    note: z.string(),
    state: ItemStateSchema,
    version: z.number().int().positive(),
    collected_by: z.object({ kind: z.enum(["user", "system_account"]), id: z.string().uuid() }),
    admitted_target_kind: IntakeTargetKindSchema.nullable(),
    admitted_target_id: z.string().uuid().nullable(),
    attachment: IntakeAttachmentSchema.nullable().describe(
      "The file this item was collected from; null for text clips and notes. Download it through the files API.",
    ),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi("IntakeItem");

const ItemEvidenceSchema = z
  .object({
    id: z.string().uuid(),
    agent: z.string(),
    session_id: z.string(),
    repo: z.string().nullable(),
    excerpt: z.string(),
    captured_at: z.string().datetime(),
    recorded_by: z.object({ kind: z.enum(["user", "system_account"]), id: z.string().uuid() }),
  })
  .openapi("IntakeItemEvidence");

export const ITEM_EVIDENCE_LIMIT = 20;

export const ItemDetailSchema = ItemSchema.extend({
  evidence: z.array(ItemEvidenceSchema).max(ITEM_EVIDENCE_LIMIT),
  evidence_total: z.number().int().nonnegative(),
}).openapi("IntakeItemDetail");

export const ProposalSchema = z
  .object({
    id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    status: z.enum(["draft", "stale", "confirmed", "rejected"]),
    current_revision: z.number().int().positive(),
    confirmed_revision: z.number().int().positive().nullable(),
    confirmed_target_kind: IntakeTargetKindSchema.nullable(),
    confirmed_target_id: z.string().uuid().nullable(),
    rejected_at: z.string().datetime().nullable(),
    stale_reason: z.string().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    revision: z.object({
      revision: z.number().int().positive(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      title: z.string(),
      body: z.string(),
      target: IntakeProposalTargetSchema,
      items: z.array(
        z.object({
          id: z.string().uuid(),
          version: z.number().int().positive(),
          title: z.string(),
          source_url: z.string().url().nullable(),
          source_author: z.string().nullable().optional(),
          published_at: z.string().nullable().optional(),
        }),
      ),
      created_at: z.string().datetime(),
    }),
  })
  .openapi("IntakeProposal");

export const CreateItemSchema = z
  .object({
    client_request_id: z.string().uuid(),
    category: CategorySchema.optional(),
    title: z.string().trim().min(1).max(1_000),
    source_url: z
      .string()
      .url()
      .optional()
      .describe("Address of the collected source. Leave it out to collect a note."),
    source_author: z.string().trim().min(1).max(1_000).optional(),
    published_at: z.string().min(1).max(1_000).optional(),
    captured_at: z.string().datetime(),
    body: z.string().min(1).max(2_000_000),
    note: z.string().max(20_000).optional(),
    original_snapshot: SnapshotSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.source_url !== undefined) return;
    if (value.original_snapshot?.source_url !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "a note without source_url cannot carry an original source_url",
        path: ["original_snapshot", "source_url"],
      });
    if (value.original_snapshot?.origin !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "a note without source_url cannot carry an original origin",
        path: ["original_snapshot", "origin"],
      });
  })
  .openapi("CreateIntakeItemBody");

export const PatchItemSchema = z
  .object({
    expected_version: z.number().int().positive(),
    category: CategorySchema.optional(),
    title: z.string().trim().min(1).max(1_000).optional(),
    body: z.string().min(1).max(2_000_000).optional(),
    note: z.string().max(20_000).optional(),
    state: z.enum(["collected", "reviewing", "discarded"]).optional(),
  })
  .refine(
    (value) =>
      value.category !== undefined ||
      value.title !== undefined ||
      value.body !== undefined ||
      value.note !== undefined ||
      value.state !== undefined,
    { message: "at least one item field is required" },
  )
  .openapi("PatchIntakeItemBody");

export const DeleteItemSchema = z
  .object({ expected_version: z.number().int().positive() })
  .openapi("DeleteIntakeItemBody");

export const CreateProposalSchema = z
  .object({
    item_ids: z.array(z.string().uuid()).min(1).max(100),
    title: z.string().trim().min(1).max(1_000),
    body: z.string().min(1).max(2_000_000),
    target: IntakeProposalTargetSchema,
  })
  .openapi("CreateIntakeProposalBody");

export const ReviseProposalSchema = CreateProposalSchema.extend({
  expected_revision: z.number().int().positive(),
}).openapi("ReviseIntakeProposalBody");

export const ConfirmProposalSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .openapi("ConfirmIntakeProposalBody");

export const RejectProposalSchema = z
  .object({ expected_revision: z.number().int().positive() })
  .openapi("RejectIntakeProposalBody");

export const ListItemsResponse = z.object({
  items: z.array(ItemSchema),
  total: z.number().int().nonnegative(),
});
const MentionItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  source_url: z.string().url().nullable(),
  category: CategorySchema,
  state: ItemStateSchema,
  version: z.number().int().positive(),
});
export const ListMentionItemsResponse = z.object({
  items: z.array(MentionItemSchema),
  total: z.number().int().nonnegative(),
});
export const ListProposalsResponse = z.object({
  items: z.array(ProposalSchema),
  total: z.number().int().nonnegative(),
});
