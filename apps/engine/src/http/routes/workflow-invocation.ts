// How to call a saved workflow — every way there is, in one read.
//
//   GET /v1/workflows/{id}/invocation   — workflow:read
//
// The answer a person opening a workflow asks first and the representation
// never gave: where to post, which headers, what input, which hook, which
// tool, which schedule. Read-only, and it carries no credential: header NAMES
// only, the API key as a placeholder, never a hook's signing secret.
//
// Assembled here from the subsystems that own each part. Schedules and hooks
// are projected by what the caller may read elsewhere (`schedule:read`,
// `inbound_hook:read`) and are absent — not empty — without it, so this route
// never widens what the sibling routes show.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  INVOKE_ENVIRONMENTS,
  INVOKE_HEADER_NAMES,
  INVOKE_RUN_PATH,
  INVOKE_SNIPPET_LANGUAGES,
  invokeRunBody,
  invokeRunUrl,
  renderInvokeSnippet,
} from "@shared/invoke-snippet.ts";
import { sql } from "drizzle-orm";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { getConfig } from "../../config/loader.ts";
import { RUN_WORKFLOW_TOOL, workflowToolName } from "../../mcp/index.ts";
import { can } from "../../rbac/index.ts";
import { listSchedules, nextScheduleFire, scheduleBindingState } from "../../scheduler/index.ts";
import { listWorkflowInboundHooks } from "../../webhooks/index.ts";
import {
  getWorkflow,
  resolveWorkflowInputSchema,
  WEBHOOK_INPUT_SHAPE,
  workflowRunAuthority,
  workflowSampleInput,
} from "../../workflows/index.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const HOOK_PATH_PREFIX = "/v1/hooks/";

const JsonObject = z.record(z.string(), z.unknown());
const Environment = z.enum(INVOKE_ENVIRONMENTS);
const Snippets = z.object({ curl: z.string(), node: z.string(), python: z.string() });
const RunAuthority = z.enum(["live_run_allowed", "held_preview_only"]);

const WorkflowInvocationSchema = z
  .object({
    workflow_id: z.string().uuid(),
    slug: z.string(),
    /** The configured public address of this engine; null when
     *  `server.public_base_url` is unset. Never derived from the request. */
    base_url: z.string().nullable(),
    http: z.object({
      method: z.literal("POST"),
      path: z.string(),
      /** `base_url` + `path`; null without a configured public address. */
      url: z.string().nullable(),
      /** Header NAMES the call carries. Values are never returned. */
      headers: z.array(z.string()),
      body: z.object({
        source: z.literal("saved"),
        workflow_id: z.string().uuid(),
        input: JsonObject,
      }),
      /** Ready-to-paste calls per environment, rendered by the same function
       *  as `sk workflows invoke-snippet`. Null without a public address. */
      snippets: z.object({ dev: Snippets, prod: Snippets }).nullable(),
    }),
    /** Absent when the caller may not read inbound hooks. */
    hooks: z
      .array(
        z.object({
          slug: z.string(),
          path: z.string(),
          url: z.string().nullable(),
          verifier: z.string(),
          /** False when the binding accepts unsigned deliveries. */
          signed: z.boolean(),
          signing_headers: z.array(z.string()),
          hmac: z
            .object({
              algorithm: z.literal("sha256"),
              encoding: z.enum(["hex", "base64"]),
              signed_payload: z.string(),
              signature_prefix: z.string(),
            })
            .nullable(),
          state: z.enum(["active", "inactive", "held"]),
          /** Deliveries always run in production. */
          environment: z.literal("prod"),
        }),
      )
      .optional(),
    mcp: z.object({
      tool_name: z.string(),
      /** Runs any saved workflow by slug — the way in when the client's tool
       *  list does not carry `tool_name`. */
      fallback: z.object({
        tool_name: z.string(),
        arguments: z.object({ workflow: z.string(), input: JsonObject }),
      }),
    }),
    /** Absent when the caller may not read schedules. */
    schedules: z
      .array(
        z.object({
          cron: z.string(),
          timezone: z.string(),
          environment: Environment,
          /** The input every scheduled run starts with. */
          input: z.unknown(),
          state: z.enum(["active", "paused", "held", "activation_required"]),
          next_fire_at: z.string().nullable(),
        }),
      )
      .optional(),
    cli: z.object({
      command: z.string(),
      /** Where the command runs: it sends no environment header. */
      environment: Environment,
    }),
    input: z.object({
      source: z.enum(["declared", "synthesized", "none"]),
      schema: JsonObject.nullable(),
      sample: JsonObject,
    }),
    output: z.object({ schema: JsonObject.nullable() }),
    /** What a hook delivery looks like as the workflow's `input`. */
    webhook_input_shape: z.record(z.string(), z.string()),
    /** Per environment: whether a call without an explicit approval runs
     *  live, or as a held preview that withholds writes. Advisory — decided
     *  from the stored approvals; admission is the authority. */
    authority: z.object({ dev: RunAuthority, prod: RunAuthority }),
  })
  .openapi("WorkflowInvocation");

const invocationRoute = createRoute({
  method: "get",
  path: "/v1/workflows/{id}/invocation",
  tags: ["workflows"],
  summary: "How to call this workflow: HTTP, inbound hooks, MCP, schedules and CLI",
  description:
    "Everything a caller needs to run the saved workflow, in one read: the run request (`POST /v1/executions`) with header names, an example body and ready-to-paste snippets; its inbound hooks with their signing scheme; its MCP tool name; its schedules; the CLI command; the input and output schema with a sample input; and whether a run in each environment would have effects. `http.url`, `hooks[].url` and `http.snippets` are null until `server.public_base_url` is configured. `hooks` and `schedules` are present only when the caller holds `inbound_hook:read` and `schedule:read`. Carries no credential: header names only, never a key or a signing secret.",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: WorkflowInvocationSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

/** The configured public address, without a trailing slash; null when unset. */
function publicBaseUrl(): string | null {
  const configured = getConfig().server.public_base_url?.trim();
  return configured ? configured.replace(/\/+$/, "") : null;
}

/** A JSON document as one single-quoted shell word. */
function shellJson(value: unknown): string {
  return `'${JSON.stringify(value).replaceAll("'", `'\\''`)}'`;
}

export function registerWorkflowInvocationRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use(
    "/v1/workflows/:id/invocation",
    requirePermission("workflow:read", (c) => ({ type: "workflow", id: c.req.param("id") ?? "" })),
  );

  app.openapi(invocationRoute, async (c) => {
    const principal = requireAuth(c);
    const tenant = principal.tenant_id;
    const db = c.get("db");
    const workflow = await getWorkflow(tenant, c.req.valid("param").id, db);
    if (!workflow) throw new NotFoundError("workflow");

    // A reader without these sees the workflow but not its bindings — routine,
    // and the same projection `automation-status` makes.
    const may = async (permission: "inbound_hook:read" | "schedule:read") =>
      (await can(db, { tenant_id: tenant, principal, permission, quiet: true })).allow;
    const [mayHooks, maySchedules] = await Promise.all([
      may("inbound_hook:read"),
      may("schedule:read"),
    ]);

    const baseUrl = publicBaseUrl();
    const input = resolveWorkflowInputSchema(workflow.definition);
    const sample = workflowSampleInput(workflow.definition, input.schema);
    const snippetsFor = (environment: (typeof INVOKE_ENVIRONMENTS)[number], engineUrl: string) =>
      Object.fromEntries(
        INVOKE_SNIPPET_LANGUAGES.map((lang) => [
          lang,
          renderInvokeSnippet({
            lang,
            engineUrl,
            workflowId: workflow.id,
            environment,
            input: sample,
          }),
        ]),
      ) as z.infer<typeof Snippets>;

    const clock = await db.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
    const now = clock.rows[0]?.now;
    if (!now) throw new Error("database clock unavailable");

    const [hooks, schedules, authority] = await Promise.all([
      mayHooks ? listWorkflowInboundHooks(tenant, workflow.id, db) : null,
      maySchedules ? listSchedules(db, tenant, workflow.id) : null,
      workflowRunAuthority(db, workflow),
    ]);

    return c.json(
      {
        workflow_id: workflow.id,
        slug: workflow.slug,
        base_url: baseUrl,
        http: {
          method: "POST" as const,
          path: INVOKE_RUN_PATH,
          url: baseUrl ? invokeRunUrl(baseUrl) : null,
          headers: [...INVOKE_HEADER_NAMES],
          body: invokeRunBody(workflow.id, sample),
          snippets: baseUrl
            ? { dev: snippetsFor("dev", baseUrl), prod: snippetsFor("prod", baseUrl) }
            : null,
        },
        ...(hooks
          ? {
              hooks: hooks.map((hook) => {
                const path = `${HOOK_PATH_PREFIX}${encodeURIComponent(hook.slug)}`;
                return {
                  slug: hook.slug,
                  path,
                  url: baseUrl ? `${baseUrl}${path}` : null,
                  verifier: hook.verifier,
                  signed: hook.signed,
                  signing_headers: hook.headers,
                  hmac: hook.hmac,
                  state: hook.state,
                  environment: "prod" as const,
                };
              }),
            }
          : {}),
        mcp: {
          tool_name: workflowToolName(workflow.slug),
          fallback: {
            tool_name: RUN_WORKFLOW_TOOL,
            arguments: { workflow: workflow.slug, input: sample },
          },
        },
        ...(schedules
          ? {
              schedules: schedules.rows.map((schedule) => {
                const state = scheduleBindingState({
                  paused: schedule.paused,
                  admission_hold: schedule.admission_hold,
                  lifecycle: workflow.lifecycle,
                  current_version_id: workflow.current_version_id,
                });
                return {
                  cron: schedule.cron,
                  timezone: schedule.timezone,
                  environment: schedule.execution_mode,
                  input: schedule.input ?? null,
                  state,
                  next_fire_at:
                    state === "active" ? nextScheduleFire(schedule, new Date(now)) : null,
                };
              }),
            }
          : {}),
        cli: {
          command: `sk workflows run ${workflow.slug} --input ${shellJson(sample)}`,
          environment: "dev" as const,
        },
        input: { ...input, sample },
        output: { schema: workflow.definition.output_schema ?? null },
        webhook_input_shape: { ...WEBHOOK_INPUT_SHAPE },
        authority,
      },
      200,
    );
  });
}
