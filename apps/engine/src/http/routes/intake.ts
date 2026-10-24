import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { CategorySchema } from "../../api/catalog-metadata.ts";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import {
  IntakeItemSnapshotSchema,
  IntakeProposalTargetSchema,
  IntakeTargetKindSchema,
} from "../../api/intake-schemas.ts";
import { actorOf } from "../../audit/index.ts";
import * as intake from "../../knowledge/index.ts";
import { can } from "../../rbac/index.ts";
import { ConflictError, HttpError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { ensurePermission, requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

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

const DefaultCategorySchema = z
  .object({ category: CategorySchema })
  .openapi("IntakeDefaultCategory");

const DefaultCategoryCheckSchema = z
  .object({ category: CategorySchema, can_collect: z.boolean() })
  .openapi("IntakeDefaultCategoryCheck");

const ItemStateSchema = z.enum(["collected", "reviewing", "admitted", "discarded"]);

const ItemSchema = z
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

const ITEM_EVIDENCE_LIMIT = 20;

const ItemDetailSchema = ItemSchema.extend({
  evidence: z.array(ItemEvidenceSchema).max(ITEM_EVIDENCE_LIMIT),
  evidence_total: z.number().int().nonnegative(),
}).openapi("IntakeItemDetail");

const ProposalSchema = z
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
        }),
      ),
      created_at: z.string().datetime(),
    }),
  })
  .openapi("IntakeProposal");

const CreateItemSchema = z
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

const PatchItemSchema = z
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

const CreateProposalSchema = z
  .object({
    item_ids: z.array(z.string().uuid()).min(1).max(100),
    title: z.string().trim().min(1).max(1_000),
    body: z.string().min(1).max(2_000_000),
    target: IntakeProposalTargetSchema,
  })
  .openapi("CreateIntakeProposalBody");

const ReviseProposalSchema = CreateProposalSchema.extend({
  expected_revision: z.number().int().positive(),
}).openapi("ReviseIntakeProposalBody");

const ConfirmProposalSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .openapi("ConfirmIntakeProposalBody");

const RejectProposalSchema = z
  .object({ expected_revision: z.number().int().positive() })
  .openapi("RejectIntakeProposalBody");

const ListItemsResponse = z.object({
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
const ListMentionItemsResponse = z.object({
  items: z.array(MentionItemSchema),
  total: z.number().int().nonnegative(),
});
const ListProposalsResponse = z.object({
  items: z.array(ProposalSchema),
  total: z.number().int().nonnegative(),
});

const getDefaultCategoryRoute = createRoute({
  method: "get",
  path: "/v1/intake/default-category",
  tags: ["intake"],
  summary: "Read the caller's personal default shared category",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: DefaultCategoryCheckSchema } },
    },
  },
});

const setDefaultCategoryRoute = createRoute({
  method: "patch",
  path: "/v1/intake/default-category",
  tags: ["intake"],
  summary: "Set the caller's personal default shared category",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: DefaultCategorySchema } } } },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: DefaultCategorySchema } } },
  },
});

const listItemsRoute = createRoute({
  method: "get",
  path: "/v1/intake/items",
  tags: ["intake"],
  summary: "List collected clips without adding them to knowledge retrieval",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      category: CategorySchema.optional(),
      state: ItemStateSchema.optional(),
      origin: z
        .enum(intake.INTAKE_ITEM_ORIGIN_FILTERS)
        .optional()
        .describe(
          "capture: collected from a source address; note: written without an address; session: prepared by an AI agent from a work session.",
        ),
    }),
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ListItemsResponse } } },
  },
});

const createItemRoute = createRoute({
  method: "post",
  path: "/v1/intake/items",
  tags: ["intake"],
  summary: "Collect an immutable source clip or a note without a source address",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateItemSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: ItemSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listMentionItemsRoute = createRoute({
  method: "get",
  path: "/v1/intake/items/mentions",
  tags: ["intake"],
  summary: "List metadata-only intake references for mentions",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      id: z.string().uuid().optional(),
      q: z.string().trim().min(1).max(200).optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ListMentionItemsResponse } },
    },
  },
});

const getItemRoute = createRoute({
  method: "get",
  path: "/v1/intake/items/{id}",
  tags: ["intake"],
  summary: "Read an intake clip, its immutable provenance and its latest session evidence",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ItemDetailSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const patchItemRoute = createRoute({
  method: "patch",
  path: "/v1/intake/items/{id}",
  tags: ["intake"],
  summary: "Organize an intake clip without changing its original source snapshot",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: PatchItemSchema } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ItemSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Changed", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listProposalsRoute = createRoute({
  method: "get",
  path: "/v1/intake/proposals",
  tags: ["intake"],
  summary: "List reviewable knowledge proposals",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({ status: z.enum(["draft", "stale", "confirmed", "rejected"]).optional() }),
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ListProposalsResponse } } },
  },
});

const createProposalRoute = createRoute({
  method: "post",
  path: "/v1/intake/proposals",
  tags: ["intake"],
  summary: "Create a versioned proposal from collected clips",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateProposalSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: ProposalSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getProposalRoute = createRoute({
  method: "get",
  path: "/v1/intake/proposals/{id}",
  tags: ["intake"],
  summary: "Read the current proposal revision, source references, and digest",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ProposalSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const reviseProposalRoute = createRoute({
  method: "patch",
  path: "/v1/intake/proposals/{id}",
  tags: ["intake"],
  summary: "Revise a proposal, creating a new reviewable revision",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: ReviseProposalSchema } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ProposalSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Changed", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const confirmProposalRoute = createRoute({
  method: "post",
  path: "/v1/intake/proposals/{id}/confirm",
  tags: ["intake"],
  summary: "Confirm the exact reviewed proposal revision and publish it as knowledge or a skill",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: ConfirmProposalSchema } } },
  },
  responses: {
    200: { description: "Confirmed", content: { "application/json": { schema: ProposalSchema } } },
    403: {
      description: "Human confirmation required",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Changed", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const rejectProposalRoute = createRoute({
  method: "post",
  path: "/v1/intake/proposals/{id}/reject",
  tags: ["intake"],
  summary: "Reject a proposal revision",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: RejectProposalSchema } } },
  },
  responses: {
    200: { description: "Rejected", content: { "application/json": { schema: ProposalSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Changed", content: { "application/json": { schema: ErrorSchema } } },
  },
});

function rethrowIntakeError(error: unknown): never {
  if (error instanceof intake.IntakeNotFoundError) throw new NotFoundError("intake resource");
  if (error instanceof intake.IntakeConfirmationActorError)
    throw new HttpError(403, "human_confirmation_required", error.message);
  if (error instanceof intake.IntakeConflictError) {
    throw new ConflictError(error.message, { reason: error.name });
  }
  throw error;
}

export function registerIntakeRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/intake/default-category", async (c, next) =>
    c.req.method === "GET"
      ? requirePermission("intake:read")(c, next)
      : requirePermission("intake:write")(c, next),
  );
  app.use("/v1/intake/items", async (c, next) =>
    c.req.method === "GET"
      ? requirePermission("intake:read")(c, next)
      : requirePermission("intake:write")(c, next),
  );
  app.use("/v1/intake/items/:id", async (c, next) =>
    c.req.method === "GET"
      ? requirePermission("intake:read")(c, next)
      : requirePermission("intake:write")(c, next),
  );
  app.use("/v1/intake/proposals", async (c, next) =>
    c.req.method === "GET"
      ? requirePermission("intake:read")(c, next)
      : requirePermission("intake:write")(c, next),
  );
  app.use("/v1/intake/proposals/:id", async (c, next) =>
    c.req.path.endsWith("/confirm")
      ? next()
      : c.req.method === "GET"
        ? requirePermission("intake:read")(c, next)
        : requirePermission("intake:write")(c, next),
  );
  app.use("/v1/intake/proposals/:id/reject", requirePermission("intake:write"));
  app.use("/v1/intake/proposals/:id/confirm", requirePermission("intake:confirm"));

  app.openapi(getDefaultCategoryRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const defaults = await intake.listIntakeCategories(
      { tenant_id: principal.tenant_id, actor: actorOf(principal) },
      db,
    );
    const collection = await can(db, {
      tenant_id: principal.tenant_id,
      principal,
      permission: "intake:write",
      quiet: true,
    });
    return c.json({ category: defaults.default_category, can_collect: collection.allow }, 200);
  });
  app.openapi(setDefaultCategoryRoute, async (c) => {
    const principal = requireAuth(c);
    return c.json(
      await intake.setIntakeDefaultCategory(
        { tenant_id: principal.tenant_id, actor: actorOf(principal), ...c.req.valid("json") },
        c.get("db"),
      ),
      200,
    );
  });
  app.openapi(listItemsRoute, async (c) => {
    const principal = requireAuth(c);
    const query = c.req.valid("query");
    const items = await intake.listIntakeItems(
      { tenant_id: principal.tenant_id, ...query },
      c.get("db"),
    );
    return c.json({ items, total: items.length }, 200);
  });

  app.openapi(listMentionItemsRoute, async (c) => {
    const principal = requireAuth(c);
    const q = c.req.valid("query");
    const items = await intake.listIntakeItems({ tenant_id: principal.tenant_id }, c.get("db"));
    const needle = q.q?.toLocaleLowerCase();
    const filtered = q.id
      ? items.filter((item) => item.id === q.id)
      : needle
        ? items.filter((item) => item.title.toLocaleLowerCase().includes(needle))
        : items;
    return c.json({
      items: filtered.map((item) => ({
        id: item.id,
        title: item.title,
        source_url: item.original_snapshot.source_url ?? null,
        category: item.category,
        state: item.state,
        version: item.version,
      })),
      total: filtered.length,
    });
  });
  app.openapi(createItemRoute, async (c) => {
    const principal = requireAuth(c);
    try {
      const item = await intake.createIntakeItem(
        { tenant_id: principal.tenant_id, actor: actorOf(principal), ...c.req.valid("json") },
        c.get("db"),
      );
      return c.json(item, 201);
    } catch (error) {
      rethrowIntakeError(error);
    }
  });
  app.openapi(getItemRoute, async (c) => {
    const principal = requireAuth(c);
    const item = await intake.getIntakeItem(
      principal.tenant_id,
      c.req.valid("param").id,
      c.get("db"),
    );
    if (!item) throw new NotFoundError("intake_item");
    const { evidence, evidence_total } = await intake.readIntakeItemEvidence(
      { tenant_id: principal.tenant_id, item_id: item.id, limit: ITEM_EVIDENCE_LIMIT },
      c.get("db"),
    );
    return c.json(
      {
        ...item,
        evidence: evidence.map((row) => ({
          id: row.id,
          agent: row.agent,
          session_id: row.session_id,
          repo: row.repo,
          excerpt: row.excerpt,
          captured_at: row.captured_at,
          recorded_by: row.recorded_by,
        })),
        evidence_total,
      },
      200,
    );
  });
  app.openapi(patchItemRoute, async (c) => {
    const principal = requireAuth(c);
    try {
      const item = await intake.patchIntakeItem(
        {
          tenant_id: principal.tenant_id,
          actor: actorOf(principal),
          id: c.req.valid("param").id,
          ...c.req.valid("json"),
        },
        c.get("db"),
      );
      if (!item) throw new NotFoundError("intake_item");
      return c.json(item, 200);
    } catch (error) {
      rethrowIntakeError(error);
    }
  });
  app.openapi(listProposalsRoute, async (c) => {
    const principal = requireAuth(c);
    const proposals = await intake.listIntakeProposals(
      { tenant_id: principal.tenant_id, ...c.req.valid("query") },
      c.get("db"),
    );
    return c.json({ items: proposals, total: proposals.length }, 200);
  });
  app.openapi(createProposalRoute, async (c) => {
    const principal = requireAuth(c);
    try {
      const proposal = await intake.createIntakeProposal(
        { tenant_id: principal.tenant_id, actor: actorOf(principal), ...c.req.valid("json") },
        c.get("db"),
      );
      return c.json(proposal, 201);
    } catch (error) {
      rethrowIntakeError(error);
    }
  });
  app.openapi(getProposalRoute, async (c) => {
    const principal = requireAuth(c);
    const proposal = await intake.getIntakeProposal(
      principal.tenant_id,
      c.req.valid("param").id,
      c.get("db"),
    );
    if (!proposal) throw new NotFoundError("intake_proposal");
    return c.json(proposal, 200);
  });
  app.openapi(reviseProposalRoute, async (c) => {
    const principal = requireAuth(c);
    try {
      const proposal = await intake.reviseIntakeProposal(
        {
          tenant_id: principal.tenant_id,
          actor: actorOf(principal),
          id: c.req.valid("param").id,
          ...c.req.valid("json"),
        },
        c.get("db"),
      );
      if (!proposal) throw new NotFoundError("intake_proposal");
      return c.json(proposal, 200);
    } catch (error) {
      rethrowIntakeError(error);
    }
  });
  app.openapi(confirmProposalRoute, async (c) => {
    const principal = requireAuth(c);
    if (principal.kind !== "user" || principal.auth_source?.kind !== "browser_session") {
      throw new HttpError(
        403,
        "human_confirmation_required",
        "a signed-in person must confirm the admission in the review",
      );
    }
    const db = c.get("db");
    try {
      const proposal = await intake.confirmIntakeProposal(
        {
          tenant_id: principal.tenant_id,
          actor: actorOf(principal),
          id: c.req.valid("param").id,
          ...c.req.valid("json"),
          authorize: async (requirements) => {
            for (const requirement of requirements)
              await ensurePermission(c, requirement.permission, requirement.resource);
          },
        },
        db,
      );
      if (!proposal) throw new NotFoundError("intake_proposal");
      return c.json(proposal, 200);
    } catch (error) {
      rethrowIntakeError(error);
    }
  });
  app.openapi(rejectProposalRoute, async (c) => {
    const principal = requireAuth(c);
    try {
      const proposal = await intake.rejectIntakeProposal(
        {
          tenant_id: principal.tenant_id,
          actor: actorOf(principal),
          id: c.req.valid("param").id,
          ...c.req.valid("json"),
        },
        c.get("db"),
      );
      if (!proposal) throw new NotFoundError("intake_proposal");
      return c.json(proposal, 200);
    } catch (error) {
      rethrowIntakeError(error);
    }
  });
}
