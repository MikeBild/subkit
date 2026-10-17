import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { TRANSCRIPT_MAX_CHARS } from "../../api/agent-sessions.ts";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { DOMAIN_SLUG_RE } from "../../api/domain-slug.ts";
import { AuditAction, actorOf, audit, auditActor } from "../../audit/index.ts";
import { scrubString } from "../../logging/scrub-secrets.ts";
import type { AgentSessionAnalyzeJob } from "../../queue/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

export interface RegisterAgentSessionRoutesOptions {
  enqueue: (job: AgentSessionAnalyzeJob) => Promise<void>;
}

const CaptureBody = z
  .object({
    agent: z
      .string()
      .min(1)
      .max(40)
      .openapi({ description: "Producing agent, e.g. claude-code, codex", example: "claude-code" }),
    session_id: z.string().min(1).max(200).optional(),
    repo: z.string().min(1).max(300).optional(),
    domains: z.array(z.string().regex(DOMAIN_SLUG_RE)).max(10).default([]),
    transcript: z.string().min(1).max(TRANSCRIPT_MAX_CHARS),
  })
  .openapi("AgentSessionCaptureBody");

const CaptureResponse = z
  .object({ queued: z.boolean(), transcript_chars: z.number().int() })
  .openapi("AgentSessionCaptureResponse");

const captureRoute = createRoute({
  method: "post",
  path: "/v1/agent/sessions",
  tags: ["agent"],
  summary: "Capture a coding-agent session transcript for learning distillation",
  description:
    "Accepts a session transcript (JSONL or plain text) plus metadata. Distillation runs " +
    "asynchronously; extracted learnings become `session_learning` (practice) or `knowledge_learning` (fact) candidates that " +
    "wait for human review — nothing goes live from this endpoint.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: CaptureBody } } },
  },
  responses: {
    202: {
      description: "Accepted — analysis queued",
      content: { "application/json": { schema: CaptureResponse } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerAgentSessionRoutes(
  app: OpenAPIHono<AppEnv>,
  opts: RegisterAgentSessionRoutesOptions,
): void {
  app.use("/v1/agent/sessions", requirePermission("skill:propose"));

  app.openapi(captureRoute, async (c) => {
    const principal = requireAuth(c);
    const body = c.req.valid("json");
    const transcript = scrubString(body.transcript);

    const job: AgentSessionAnalyzeJob = {
      tenant_id: principal.tenant_id,
      agent: body.agent,
      ...(body.session_id ? { session_id: body.session_id } : {}),
      ...(body.repo ? { repo: body.repo } : {}),
      domains: body.domains,
      transcript,
      actor: actorOf(principal),
    };
    await opts.enqueue(job);

    audit(
      {
        tenant_id: principal.tenant_id,
        ...auditActor(actorOf(principal)),
        action: AuditAction.AGENT_SESSION_CAPTURED,
        resource_type: "skill_candidate",
        resource_id: null,
        result: "success",
        metadata: {
          agent: body.agent,
          session_id: body.session_id ?? null,
          repo: body.repo ?? null,
          domains: body.domains,
          transcript_chars: transcript.length,
        },
      },
      c.get("db"),
    );

    return c.json({ queued: true, transcript_chars: transcript.length }, 202);
  });
}
