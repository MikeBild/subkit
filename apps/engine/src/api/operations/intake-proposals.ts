import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import { requireSignedInPerson } from "../../http/middleware/auth.ts";
import {
  confirmIntakeProposal,
  createIntakeProposal,
  getIntakeProposal,
  listIntakeProposals,
  rejectIntakeProposal,
  reviseIntakeProposal,
} from "../../knowledge/intake.ts";
import type { IntakeProposalView } from "../../knowledge/intake-types.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, isRejection, reject } from "./index.ts";
import {
  INTAKE_READ,
  INTAKE_TAGS,
  INTAKE_WRITE,
  type IntakeIdInput,
  intakeCaller,
  intakeFailure,
  intakeIdInput,
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

type ListProposalsInput = z.infer<typeof ListProposalsQuery>;
type CreateProposalInput = z.infer<typeof CreateProposalSchema>;
type ReviseProposalFields = z.infer<typeof ReviseProposalSchema>;
type ConfirmProposalFields = z.infer<typeof ConfirmProposalSchema>;
type RejectProposalFields = z.infer<typeof RejectProposalSchema>;

function proposalNotFound() {
  return reject.notFound("intake_proposal");
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
