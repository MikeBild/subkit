import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { runGenerateFlow } from "../../../llm/index.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { streamTenantSSE as streamSSE } from "../../tenant-stream.ts";

const GenerateBody = z
  .object({
    description: z.string().min(1),
    connector_id: z.string().uuid().optional(),
    workflow_id: z.string().uuid().optional(),
    preview: z.boolean().optional(),
  })
  .openapi("AiGenerateBody");

const GenerateResponse = z
  .object({
    draft_workflow: z.record(z.string(), z.unknown()),
    included_skills: z.array(z.string()),
    included_chunks: z.array(z.string()),
    tokens: z.record(z.string(), z.number()),
    model_used: z.string(),
    fell_back: z.boolean(),
  })
  .openapi("AiGenerateResponse");

const route = createRoute({
  method: "post",
  path: "/v1/ai/generate",
  tags: ["ai"],
  summary: "Generate a workflow draft from a natural-language description",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({
        stream: z
          .union([z.literal("1"), z.literal("0"), z.literal("true"), z.literal("false")])
          .optional(),
      })
      .openapi("AiGenerateQuery"),
    body: { content: { "application/json": { schema: GenerateBody } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: GenerateResponse } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

function shouldStream(q: { stream?: string | undefined }): boolean {
  return q.stream === "1" || q.stream === "true";
}

export function registerAiGenerateRoute(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/ai/generate", async (c, next) => {
    if (c.req.method !== "POST") return next();
    return requirePermission("workflow:write")(c, next);
  });

  app.use("/v1/ai/generate", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const url = new URL(c.req.url);
    const streamFlag = url.searchParams.get("stream");
    if (streamFlag !== "1" && streamFlag !== "true") return next();
    const principal = requireAuth(c);
    const db = c.get("db");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(
        { code: "bad_request", message: "invalid json", trace_id: c.get("trace_id") },
        400,
      );
    }
    const parsed = GenerateBody.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { code: "bad_request", message: "invalid body", trace_id: c.get("trace_id") },
        400,
      );
    }
    return streamSSE(c, async (stream) => {
      const result = await runGenerateFlow(
        {
          tenant_id: principal.tenant_id,
          description: parsed.data.description,
          ...(parsed.data.connector_id ? { connector_id: parsed.data.connector_id } : {}),
          ...(parsed.data.workflow_id ? { workflow_id: parsed.data.workflow_id } : {}),
          ...(parsed.data.preview !== undefined ? { preview: parsed.data.preview } : {}),
        },
        db,
      );
      const draft = result.draft_workflow as Record<string, unknown>;
      const frames: Array<{ event: string; partial: Record<string, unknown> }> = [
        { event: "draft.name", partial: { name: draft.name ?? "" } },
        { event: "draft.description", partial: { description: draft.description ?? "" } },
        { event: "draft.steps", partial: { steps: draft.steps ?? [] } },
        {
          event: "draft.final",
          partial: {
            draft_workflow: draft,
            included_skills: result.included_skill_ids,
            included_chunks: result.included_chunk_ids,
            tokens: result.tokens,
            model_used: result.model_used,
            fell_back: result.fell_back,
          },
        },
      ];
      for (const f of frames) {
        await stream.writeSSE({ event: f.event, data: JSON.stringify(f.partial) });
      }
    });
  });

  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const q = c.req.valid("query");
    void shouldStream(q);
    const result = await runGenerateFlow(
      {
        tenant_id: principal.tenant_id,
        description: body.description,
        ...(body.connector_id ? { connector_id: body.connector_id } : {}),
        ...(body.workflow_id ? { workflow_id: body.workflow_id } : {}),
        ...(body.preview !== undefined ? { preview: body.preview } : {}),
      },
      db,
    );
    return c.json(
      {
        draft_workflow: result.draft_workflow as Record<string, unknown>,
        included_skills: result.included_skill_ids,
        included_chunks: result.included_chunk_ids,
        tokens: {
          system: result.tokens.system,
          skills: result.tokens.skills,
          docs: result.tokens.docs,
          failures: result.tokens.failures,
          messages: result.tokens.messages,
          total: result.tokens.total,
        },
        model_used: result.model_used,
        fell_back: result.fell_back,
      },
      200,
    );
  });
}
