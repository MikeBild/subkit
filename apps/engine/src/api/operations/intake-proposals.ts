import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import { getConfig } from "../../config/loader.ts";
import type { ToolContext, ToolResult } from "../../conversations/tools/index.ts";
import { requireSignedInPerson } from "../../http/middleware/auth.ts";
import { getKnowledgeSource } from "../../knowledge/catalog.ts";
import {
  confirmIntakeProposal,
  createIntakeProposal,
  getIntakeItem,
  getIntakeProposal,
  listIntakeProposals,
  rejectIntakeProposal,
  reviseIntakeProposal,
} from "../../knowledge/intake.ts";
import { IntakeNotFoundError } from "../../knowledge/intake-errors.ts";
import type { IntakeProposalView } from "../../knowledge/intake-types.ts";
import { IdParam } from "../common-schemas.ts";
import { IntakeProposalTargetSchema } from "../intake-schemas.ts";
import { defineOperation, isRejection, type Rejection, reject } from "./index.ts";
import {
  INTAKE_READ,
  INTAKE_TAGS,
  INTAKE_WRITE,
  type IntakeIdInput,
  intakeCaller,
  intakeFailure,
  intakeIdInput,
  intakeReadVersions,
  intakeRejectionMessage,
  intakeSourcesReadAtCurrentVersion,
  selectedIntakeIds,
} from "./intake.ts";
import {
  ConfirmProposalSchema,
  CreateProposalSchema,
  ListProposalsResponse,
  ProposalSchema,
  RejectProposalSchema,
  ReviseProposalSchema,
} from "./intake-representation.ts";

const ListProposalsQuery = z.object({
  status: z.enum(["draft", "stale", "confirmed", "rejected"]).optional(),
});

const ExistingKnowledgeTargetSchema = z
  .object({ knowledge_source_id: z.string().uuid() })
  .describe(
    "Knowledge destination for facts or reference material: extends an existing knowledge bundle. Use an id returned by list_knowledge_sources or get_knowledge_source; the current version is filled in.",
  );
const ProposalTargetToolInput = z.union([
  IntakeProposalTargetSchema,
  ExistingKnowledgeTargetSchema,
]);
const CreateProposalToolInput = z
  .object({
    item_ids: z.array(z.string().uuid()).min(1).max(100).optional(),
    title: z.string().min(1).max(1_000),
    body: z.string().min(1).max(2_000_000),
    target: ProposalTargetToolInput,
  })
  .openapi("CreateIntakeProposalToolInput");
const ReviseProposalToolInput = CreateProposalToolInput.extend({
  id: z.string().uuid(),
  expected_revision: z.number().int().positive(),
  item_ids: z.array(z.string().uuid()).min(1).max(100),
}).openapi("ReviseIntakeProposalToolInput");

interface ReadVersions {
  readonly expected_item_versions?: Record<string, number>;
}

type ListProposalsInput = z.infer<typeof ListProposalsQuery>;
type CreateProposalInput = z.infer<typeof CreateProposalSchema> & ReadVersions;
type ReviseProposalFields = z.infer<typeof ReviseProposalSchema> & ReadVersions;
type ProposalTarget = z.infer<typeof IntakeProposalTargetSchema>;
type ProposalTargetArg = z.infer<typeof ProposalTargetToolInput>;
type CreateProposalArgs = z.infer<typeof CreateProposalToolInput>;
type ReviseProposalArgs = z.infer<typeof ReviseProposalToolInput>;
type ConfirmProposalFields = z.infer<typeof ConfirmProposalSchema>;
type RejectProposalFields = z.infer<typeof RejectProposalSchema>;

function proposalNotFound() {
  return reject.notFound("intake_proposal");
}

function proposalFailure(
  error_code: string,
  message: string,
  next_best_actions: string[],
  extra: Record<string, unknown> = {},
): ToolResult {
  return {
    ok: false,
    error_code,
    message,
    data: { error: error_code, message, ...extra },
    next_best_actions,
  };
}

function selectedOnly(ids: Set<string>, requested: readonly string[]): boolean {
  return ids.size > 0 && requested.every((id) => ids.has(id));
}

function notSelectedFailure(selected: Set<string>, requested: readonly string[]): ToolResult {
  const stray = requested.filter((id) => !selected.has(id));
  return proposalFailure(
    "intake_item_not_selected",
    `item_ids may only contain the intake items selected for this review (${[...selected].join(", ") || "none"}); ${stray.join(", ")} is not one of them. A knowledge source id belongs in target.knowledge_source_id, never in item_ids.`,
    ["list_intake_items", "get_intake_item"],
    { selected_item_ids: [...selected], rejected_ids: stray },
  );
}

async function decidedItemFailure(
  ctx: ToolContext,
  ids: readonly string[],
): Promise<ToolResult | null> {
  const items = await Promise.all(ids.map((id) => getIntakeItem(ctx.tenant_id, id, ctx.db)));
  const decided = items.filter(
    (item) => item !== null && (item.state === "admitted" || item.state === "discarded"),
  );
  if (!decided.length) return null;
  return proposalFailure(
    "intake_item_already_admitted",
    `${decided.map((item) => `'${item?.title}' is ${item?.state}`).join("; ")}. A decided item cannot be proposed again. Changing knowledge that came from it happens in a normal chat: offer the person to open one.`,
    [],
    { decided_item_ids: decided.map((item) => item?.id) },
  );
}

async function resolveProposalTarget(
  ctx: ToolContext,
  target: ProposalTargetArg,
  selected: Set<string>,
): Promise<{ target: ProposalTarget } | { failure: ToolResult }> {
  if (!("knowledge_source_id" in target)) return { target };
  const source = await getKnowledgeSource(ctx.tenant_id, target.knowledge_source_id, ctx.db);
  if (!source) {
    const isItem = selected.has(target.knowledge_source_id);
    return {
      failure: proposalFailure(
        "knowledge_source_not_found",
        isItem
          ? `'${target.knowledge_source_id}' is an intake item id, not a knowledge source id. Put intake items in item_ids and use an id from list_knowledge_sources in target.knowledge_source_id.`
          : `No knowledge source '${target.knowledge_source_id}' exists. Use an id returned by list_knowledge_sources or get_knowledge_source.`,
        ["list_knowledge_sources"],
      ),
    };
  }
  if (source.source_type !== "bundle") {
    return {
      failure: proposalFailure(
        "knowledge_target_not_bundle",
        `'${source.name}' is a ${source.source_type} source and cannot be extended from intake. Propose a new knowledge source instead.`,
        ["list_knowledge_sources"],
      ),
    };
  }
  const given = "expected_version" in target ? target.expected_version : undefined;
  if (given !== undefined && given !== source.version) {
    return {
      failure: proposalFailure(
        "knowledge_target_changed",
        `'${source.name}' changed since it was read. Use expected_version '${source.version}' or leave expected_version out.`,
        ["get_knowledge_source"],
        { current_version: source.version },
      ),
    };
  }
  return { target: { knowledge_source_id: source.id, expected_version: source.version } };
}

async function toolTarget(ctx: ToolContext, target: ProposalTargetArg): Promise<ProposalTarget> {
  const resolved = await resolveProposalTarget(ctx, target, selectedIntakeIds(ctx));
  return "target" in resolved ? resolved.target : (target as ProposalTarget);
}

async function proposalRefusal(
  ctx: ToolContext,
  item_ids: readonly string[],
  target: ProposalTarget,
): Promise<ToolResult | null> {
  const selected = selectedIntakeIds(ctx);
  if (!selectedOnly(selected, item_ids)) return notSelectedFailure(selected, item_ids);
  const decided = await decidedItemFailure(ctx, item_ids);
  if (decided) return decided;
  if (!(await intakeSourcesReadAtCurrentVersion(ctx, item_ids))) {
    return { ok: false, data: { error: "intake_items_must_be_read" } };
  }
  const resolved = await resolveProposalTarget(ctx, target, selected);
  return "failure" in resolved ? resolved.failure : null;
}

function proposalMessageResult(message: string, notFound: boolean): ToolResult {
  if (notFound && message.startsWith("knowledge_source ")) {
    return proposalFailure("knowledge_source_not_found", message, ["list_knowledge_sources"]);
  }
  if (message === "knowledge target has changed")
    return proposalFailure("knowledge_target_changed", message, ["get_knowledge_source"]);
  if (message === "discarded or admitted items cannot be proposed")
    return proposalFailure(
      "intake_item_already_admitted",
      `${message}. Changing knowledge that came from a decided item happens in a normal chat: offer the person to open one.`,
      [],
    );
  return { ok: false, data: { error: message } };
}

function proposalRejectionResult(outcome: Rejection): ToolResult {
  const message = intakeRejectionMessage(outcome);
  if (message !== undefined) return proposalMessageResult(message, outcome.status === 404);
  if (outcome.status === 404) return { ok: false, data: { error: "intake_proposal_not_found" } };
  return proposalMessageResult(outcome.message, false);
}

function proposalErrorResult(error: unknown): ToolResult {
  return proposalMessageResult(
    error instanceof Error ? error.message : "intake_proposal_failed",
    error instanceof IntakeNotFoundError,
  );
}

function proposalReviewPath(itemId: string, id: string): string {
  return `/cockpit/intake/${encodeURIComponent(itemId)}?tab=review&proposal=${encodeURIComponent(id)}`;
}

function publicBaseUrl(): string | null {
  try {
    const configured = getConfig().server.public_base_url;
    if (configured && configured.length > 0)
      return configured.endsWith("/") ? configured.slice(0, -1) : configured;
  } catch {}
  return null;
}

export function proposalReviewUrl(
  publicBaseUrl: string | null,
  itemId: string,
  id: string,
): string | null {
  if (!publicBaseUrl) return null;
  return `${publicBaseUrl.endsWith("/") ? publicBaseUrl.slice(0, -1) : publicBaseUrl}${proposalReviewPath(itemId, id)}`;
}

function proposalHandoff(itemId: string, id: string) {
  const review_url = proposalReviewUrl(publicBaseUrl(), itemId, id);
  return {
    review_path: proposalReviewPath(itemId, id),
    ...(review_url ? { review_url } : {}),
    next_action: review_url
      ? "The person must review the exact proposal, sources, and destination in Cockpit before deciding whether to admit it. No knowledge or skill has been admitted."
      : "The proposal remains unconfirmed. In Cockpit, open the collected item and its review tab before any admission. No knowledge or skill has been admitted.",
  };
}

function humanActorRequired(ctx: ToolContext): ToolResult | null {
  return ctx.principal ? null : { ok: false, data: { error: "human_actor_required" } };
}

export const listIntakeProposalsOperation = defineOperation<
  ListProposalsInput,
  IntakeProposalView[]
>({
  id: "intake.list_proposals",
  summary: "List reviewable knowledge proposals",
  permission: INTAKE_READ,
  effect: "read",
  handler: async (scope, query) =>
    await listIntakeProposals({ tenant_id: scope.tenant_id, ...query }, scope.db),
  http: {
    method: "get",
    path: "/v1/intake/proposals",
    tags: INTAKE_TAGS,
    query: ListProposalsQuery,
    response: ListProposalsResponse,
    toInput: ({ query }) => query as ListProposalsInput,
    toBody: (items) => ({ items, total: items.length }),
  },
});

export const createIntakeProposalOperation = defineOperation<
  CreateProposalInput,
  IntakeProposalView
>({
  id: "intake.create_proposal",
  summary: "Create a versioned proposal from collected clips",
  permission: INTAKE_WRITE,
  effect: "write",
  audit: AuditAction.INTAKE_PROPOSAL_CREATED,
  async handler(scope, body) {
    const caller = intakeCaller(scope);
    if (isRejection(caller)) return caller;
    try {
      return await createIntakeProposal(
        { tenant_id: scope.tenant_id, actor: caller.actor, ...body },
        scope.db,
      );
    } catch (error) {
      return intakeFailure(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/intake/proposals",
    tags: INTAKE_TAGS,
    body: CreateProposalSchema,
    response: ProposalSchema,
    success: { status: 201, description: "Created" },
    errors: { 409: "Conflict" },
    toInput: ({ json }) => json as CreateProposalInput,
    toBody: (proposal) => proposal,
  },
  tool: {
    name: "create_intake_proposal",
    description:
      "Create a reviewable, versioned proposal from collected items whose destination is knowledge or a skill. Choose the target by what the material is: a fact or reference becomes knowledge (pass the suggested_knowledge_target from get_intake_item unchanged to extend the domain's knowledge, or {knowledge_source_id} with an id from list_knowledge_sources to extend that existing bundle — never an intake item id; the current version is filled in); a repeatable practice or convention becomes a skill ({skill:{new:{title, scope, tags, category}}} with a domain:<name> tag, or {skill:{skill_id, expected_version}} to change an existing skill at the version you read; list consolidated skills in supersedes as {skill_id, expected_version} at the version you read; they are archived on confirmation). Preserve source references. The title and body may contain claims and citations only from item_ids; keep excluded-item and prompt-injection reasoning in the review explanation, never in the proposal. This only creates a draft proposal: it admits no knowledge or skill and cannot confirm admission. Give the person the returned Cockpit review URL when available.",
    input: CreateProposalToolInput,
    gate: "enforced",
    requires_draft: true,
    async toInput(raw, ctx) {
      const args = raw as CreateProposalArgs;
      return {
        item_ids: args.item_ids ?? [...selectedIntakeIds(ctx)],
        expected_item_versions: intakeReadVersions(ctx),
        title: args.title,
        body: args.body,
        target: await toolTarget(ctx, args.target),
      };
    },
    async guard(input, ctx) {
      const actor = humanActorRequired(ctx);
      if (actor) return actor;
      if (!input.item_ids.length) return { ok: false, data: { error: "intake_items_required" } };
      return proposalRefusal(ctx, input.item_ids, input.target);
    },
    toResult: (outcome, input) =>
      isRejection(outcome)
        ? proposalRejectionResult(outcome)
        : {
            ok: true,
            data: {
              proposal: outcome,
              ...proposalHandoff(input.item_ids[0] as string, outcome.id),
            },
          },
    onError: proposalErrorResult,
  },
});

export const getIntakeProposalOperation = defineOperation<string, IntakeProposalView>({
  id: "intake.get_proposal",
  summary: "Read the current proposal revision, source references, and digest",
  permission: INTAKE_READ,
  effect: "read",
  async handler(scope, id) {
    return (await getIntakeProposal(scope.tenant_id, id, scope.db)) ?? proposalNotFound();
  },
  http: {
    method: "get",
    path: "/v1/intake/proposals/{id}",
    tags: INTAKE_TAGS,
    params: IdParam,
    response: ProposalSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => (param as { id: string }).id,
    toBody: (proposal) => proposal,
  },
});

export const reviseIntakeProposalOperation = defineOperation<
  IntakeIdInput<ReviseProposalFields>,
  IntakeProposalView
>({
  id: "intake.revise_proposal",
  summary: "Revise a proposal, creating a new reviewable revision",
  permission: INTAKE_WRITE,
  effect: "write",
  audit: AuditAction.INTAKE_PROPOSAL_REVISED,
  async handler(scope, { id, body }) {
    const caller = intakeCaller(scope);
    if (isRejection(caller)) return caller;
    try {
      const proposal = await reviseIntakeProposal(
        { tenant_id: scope.tenant_id, actor: caller.actor, id, ...body },
        scope.db,
      );
      return proposal ?? proposalNotFound();
    } catch (error) {
      return intakeFailure(error);
    }
  },
  http: {
    method: "patch",
    path: "/v1/intake/proposals/{id}",
    tags: INTAKE_TAGS,
    params: IdParam,
    body: ReviseProposalSchema,
    response: ProposalSchema,
    errors: { 404: "Not found", 409: "Changed" },
    toInput: ({ param, json }) => intakeIdInput<ReviseProposalFields>(param, json),
    toBody: (proposal) => proposal,
  },
  tool: {
    name: "revise_intake_proposal",
    description:
      "Revise a draft intake proposal into a new version, including its knowledge or skill target (same target rules as create_intake_proposal). The title and body may contain claims and citations only from item_ids; keep excluded-item and prompt-injection reasoning in the review explanation, never in the proposal. This admits no knowledge or skill. Show the returned exact content, sources, and destination to the person, then give them the Cockpit review URL when available.",
    input: ReviseProposalToolInput,
    gate: "enforced",
    permission: { resourceType: "intake", resourceIdArg: "id" },
    requires_draft: true,
    async toInput(raw, ctx) {
      const args = raw as ReviseProposalArgs;
      return {
        id: args.id,
        body: {
          expected_revision: args.expected_revision,
          item_ids: args.item_ids,
          title: args.title,
          body: args.body,
          target: await toolTarget(ctx, args.target),
          expected_item_versions: intakeReadVersions(ctx),
        },
      };
    },
    async guard({ body }, ctx) {
      return humanActorRequired(ctx) ?? proposalRefusal(ctx, body.item_ids, body.target);
    },
    toResult: (outcome, { body }) =>
      isRejection(outcome)
        ? proposalRejectionResult(outcome)
        : {
            ok: true,
            data: {
              proposal: outcome,
              ...proposalHandoff(body.item_ids[0] as string, outcome.id),
            },
          },
    onError: proposalErrorResult,
  },
});

export const confirmIntakeProposalOperation = defineOperation<
  IntakeIdInput<ConfirmProposalFields>,
  IntakeProposalView
>({
  id: "intake.confirm_proposal",
  summary: "Confirm the exact reviewed proposal revision and publish it as knowledge or a skill",
  permission: "intake:confirm",
  effect: "write",
  audit: AuditAction.INTAKE_PROPOSAL_CONFIRMED,
  async handler(scope, { id, body }) {
    const caller = intakeCaller(scope);
    if (isRejection(caller)) return caller;
    requireSignedInPerson(
      caller.principal,
      "a signed-in person must confirm the admission in the review",
    );
    const ensure = scope.ensurePermission;
    if (!ensure) throw new Error("intake.confirm_proposal needs a permission check in its scope");
    try {
      const proposal = await confirmIntakeProposal(
        {
          tenant_id: scope.tenant_id,
          actor: caller.actor,
          id,
          ...body,
          authorize: async (requirements) => {
            for (const requirement of requirements)
              await ensure(requirement.permission, requirement.resource);
          },
        },
        scope.db,
      );
      return proposal ?? proposalNotFound();
    } catch (error) {
      return intakeFailure(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/intake/proposals/{id}/confirm",
    tags: INTAKE_TAGS,
    params: IdParam,
    body: ConfirmProposalSchema,
    response: ProposalSchema,
    success: { status: 200, description: "Confirmed" },
    errors: { 403: "Human confirmation required", 404: "Not found", 409: "Changed" },
    toInput: ({ param, json }) => intakeIdInput<ConfirmProposalFields>(param, json),
    toBody: (proposal) => proposal,
  },
});

export const rejectIntakeProposalOperation = defineOperation<
  IntakeIdInput<RejectProposalFields>,
  IntakeProposalView
>({
  id: "intake.reject_proposal",
  summary: "Reject a proposal revision",
  permission: INTAKE_WRITE,
  effect: "write",
  audit: AuditAction.INTAKE_PROPOSAL_REJECTED,
  async handler(scope, { id, body }) {
    const caller = intakeCaller(scope);
    if (isRejection(caller)) return caller;
    try {
      const proposal = await rejectIntakeProposal(
        { tenant_id: scope.tenant_id, actor: caller.actor, id, ...body },
        scope.db,
      );
      return proposal ?? proposalNotFound();
    } catch (error) {
      return intakeFailure(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/intake/proposals/{id}/reject",
    tags: INTAKE_TAGS,
    params: IdParam,
    body: RejectProposalSchema,
    response: ProposalSchema,
    success: { status: 200, description: "Rejected" },
    errors: { 404: "Not found", 409: "Changed" },
    toInput: ({ param, json }) => intakeIdInput<RejectProposalFields>(param, json),
    toBody: (proposal) => proposal,
  },
});
