import { z } from "@hono/zod-openapi";
import { GateRepairError, proposeGateRepair } from "../../self-healing/index.ts";
import { diagnoseWorkflow, GateFixerSchema } from "../../workflows/index.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const DiagnoseInput = z.object({
  workflow_id: z.string().uuid(),
  environment: z.enum(["dev", "prod"]).default("prod"),
});

export const diagnoseWorkflowTool: ConversationTool = {
  name: "diagnose_workflow",
  description:
    "Say why the approval gate holds a workflow and what removes each block: every refused step " +
    "with its gate code, the report gate's own reason when it named one (for example `not_utf8`), " +
    "the remedy kind (`patch`, `prepare`, `declare`, `reconnect`, `author`), a `fixer` when a " +
    "deterministic repair exists, and `candidate_id` when that repair is already waiting for " +
    "review. Reads only; diagnoses the draft when there is one (`is_current: false`).",
  inputSchema: DiagnoseInput,
  category: "tenant_read",
  permission: { action: "workflow:read", resourceType: "workflow", resourceIdArg: "workflow_id" },
  use_case:
    "A schedule or webhook is held, a granted run was refused, or the user asks why automatic runs are not approved.",
  important_notes: [
    "Only a diagnosis with `fixer` AND `is_current: true` can be repaired with propose_workflow_repair; the others name what a person has to do.",
    "`is_current: false` is a draft: propose_workflow_repair repairs the active version only, so make the `fixer`'s change in the draft itself (or apply the draft and diagnose again).",
    "`prepare` means a held preparation run is missing — nothing needs to change in the definition.",
  ],
  async execute(ctx, raw): Promise<ToolResult> {
    const args = DiagnoseInput.parse(raw);
    const result = await diagnoseWorkflow(
      ctx.db,
      ctx.tenant_id,
      args.workflow_id,
      args.environment,
    );
    if (!result) return { ok: false, error_code: "workflow_not_found" };
    return { ok: true, data: result };
  },
};

const ProposeInput = z.object({
  workflow_id: z.string().uuid(),
  step_id: z.string().min(1),
  fixer: GateFixerSchema,
  environment: z.enum(["dev", "prod"]).default("prod"),
});

export const proposeWorkflowRepairTool: ConversationTool = {
  name: "propose_workflow_repair",
  description:
    "File the deterministic repair diagnose_workflow offers for one step (by `step_id` and " +
    "`fixer`) as a PROPOSED patch candidate for human review. The engine computes the change " +
    "from the saved definition; nothing is applied until a person approves the candidate. " +
    "Calling it again returns the same candidate.",
  inputSchema: ProposeInput,
  category: "tenant_write",
  permission: { action: "workflow:write", resourceType: "workflow", resourceIdArg: "workflow_id" },
  visible_when_readonly: true,
  inert_proposal: true,
  use_case:
    "diagnose_workflow returned `is_current: true` and a diagnosis with a `fixer` and no `candidate_id`, and the user wants it repaired.",
  important_notes: [
    "Creates a review-queue proposal only; approving it happens in the patch-candidate review.",
    "Refused when the active version offers no such repair — diagnose again after any change.",
  ],
  async execute(ctx, raw): Promise<ToolResult> {
    const args = ProposeInput.parse(raw);
    try {
      const outcome = await proposeGateRepair(ctx.db, { tenant_id: ctx.tenant_id, ...args });
      return {
        ok: true,
        data: {
          ...outcome,
          next_action:
            "Tell the user a repair is waiting for review and name the step it changes. Do not claim it is applied.",
        },
      };
    } catch (error) {
      if (!(error instanceof GateRepairError)) throw error;
      return {
        ok: false,
        error_code: error.code,
        message: error.message,
        next_best_actions: ["diagnose_workflow"],
      };
    }
  },
};
