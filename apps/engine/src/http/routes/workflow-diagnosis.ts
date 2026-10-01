// Why the approval gate holds a workflow, and the deterministic repairs for it.
//
//   GET  /v1/workflows/{id}/diagnosis?environment=  — workflow:read
//   POST /v1/workflows/{id}/repairs                 — workflow:write
//
// The diagnosis is read-only. A repair request names a step and a fixer and
// nothing else: the operations are computed by the fixer from the saved
// definition, never taken from the caller, and land as an ordinary patch
// candidate. Reviewing and applying it reuses /v1/patch-candidates/{id}/
// preview, dry-run, prepare and approve.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { GateRepairError, proposeGateRepair } from "../../self-healing/index.ts";
import {
  diagnoseWorkflow,
  GateFixerSchema,
  WorkflowDiagnosisSchema,
} from "../../workflows/index.ts";
import { HttpError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const workflowParam = z.object({ id: z.string().uuid() });

const diagnosisRoute = createRoute({
  method: "get",
  path: "/v1/workflows/{id}/diagnosis",
  tags: ["workflows"],
  summary: "Why the approval gate holds this workflow, and what removes it",
  description:
    "Diagnoses the saved version (the draft when there is one) in one environment: manifest issues, request and storage refusals, unavailable connectors and the newest refused step of a granted run. Each diagnosis names its remedy kind; a `fixer` is present when a deterministic repair exists, and `candidate_id` when one was already proposed. A repair can be proposed (POST /v1/workflows/{id}/repairs) only when `is_current` is true: on a draft the `fixer` names the change to make in the draft, or the draft has to be applied and diagnosed again. Read-only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: workflowParam,
    query: z.object({ environment: z.enum(["dev", "prod"]).default("prod") }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: WorkflowDiagnosisSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const RepairBody = z
  .object({
    step_id: z.string().min(1),
    fixer: GateFixerSchema,
    environment: z.enum(["dev", "prod"]).default("prod"),
  })
  .strict()
  .openapi("ProposeWorkflowRepairBody");

const RepairResponse = z
  .object({
    candidate_id: z.string().uuid(),
    step_id: z.string(),
    fixer: GateFixerSchema,
    status: z.string(),
    created: z.boolean(),
  })
  .openapi("ProposeWorkflowRepairResponse");

const repairRoute = createRoute({
  method: "post",
  path: "/v1/workflows/{id}/repairs",
  tags: ["workflows"],
  summary: "Propose a deterministic repair for a step the approval gate refused",
  description:
    "Files the repair the active version's diagnosis offers for this step and fixer as a reviewable patch candidate (never applied automatically). Returns the existing candidate when one already covers the block (200) — including a rejected one, which keeps holding for this version. Review and apply through /v1/patch-candidates/{id}.",
  security: [{ bearerAuth: [] }],
  request: {
    params: workflowParam,
    body: { content: { "application/json": { schema: RepairBody } } },
  },
  responses: {
    200: {
      description: "An existing candidate covers this repair",
      content: { "application/json": { schema: RepairResponse } },
    },
    201: {
      description: "Proposed",
      content: { "application/json": { schema: RepairResponse } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description: "No such repair is available for the active version",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerWorkflowDiagnosisRoutes(app: OpenAPIHono<AppEnv>): void {
  const workflowResource = (c: { req: { param: (name: string) => string | undefined } }) => ({
    type: "workflow",
    id: c.req.param("id") ?? "",
  });
  app.use("/v1/workflows/:id/diagnosis", requirePermission("workflow:read", workflowResource));
  app.use("/v1/workflows/:id/repairs", requirePermission("workflow:write", workflowResource));

  app.openapi(diagnosisRoute, async (c) => {
    const principal = requireAuth(c);
    const result = await diagnoseWorkflow(
      c.get("db"),
      principal.tenant_id,
      c.req.valid("param").id,
      c.req.valid("query").environment,
    );
    if (!result) throw new NotFoundError("workflow");
    return c.json(result, 200);
  });

  app.openapi(repairRoute, async (c) => {
    const principal = requireAuth(c);
    const body = c.req.valid("json");
    try {
      const outcome = await proposeGateRepair(c.get("db"), {
        tenant_id: principal.tenant_id,
        workflow_id: c.req.valid("param").id,
        environment: body.environment,
        step_id: body.step_id,
        fixer: body.fixer,
      });
      return c.json(outcome, outcome.created ? 201 : 200);
    } catch (error) {
      if (!(error instanceof GateRepairError)) throw error;
      if (error.code === "workflow_not_found") throw new NotFoundError("workflow");
      throw HttpError.withEnvelope(409, error.code, error.message, {
        hint: "GET /v1/workflows/{id}/diagnosis lists the repairs the active version offers.",
      });
    }
  });
}
