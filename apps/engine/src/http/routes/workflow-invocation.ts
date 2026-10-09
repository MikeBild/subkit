import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  INVOKE_ENVIRONMENTS,
  INVOKE_HEADER_NAMES,
  INVOKE_RUN_PATH,
  INVOKE_SNIPPET_LANGUAGES,
  invokeRunBody,
  invokeRunUrl,
  renderInvokeSnippet,
  shellQuote,
} from "@shared/invoke-snippet.ts";
import { sql } from "drizzle-orm";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { getConfig } from "../../config/loader.ts";
import { RUN_WORKFLOW_TOOL, workflowToolName } from "../../mcp/index.ts";
import { can, workflowStartAccess } from "../../rbac/index.ts";
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
const RunAuthority = z
  .enum(["live_run_allowed", "held_preview_only"])
  .describe(
    "`live_run_allowed`: an approval for the running version exists in this environment — unrevoked, inside its window, with runs left. It does NOT say the next run is admitted: admission also requires that the approval still matches the workflow's current effects and that those effects may run repeatedly, and holds or refuses the run otherwise. `held_preview_only`: no such approval; a call runs as a held preview that withholds writes.",
  );

const WorkflowInvocationSchema = z
  .object({
    workflow_id: z.string().uuid(),
    slug: z.string(),
    invalid: z
      .boolean()
      .describe(
        "True when the current version is stored in an earlier definition format. Everything below is read from the stored definition as written; a run is refused with `workflow_version_invalid` until the workflow is saved again.",
      ),
    base_url: z.string().nullable(),
    http: z.object({
      method: z.literal("POST"),
      path: z.string(),
      url: z.string().nullable(),
      headers: z.array(z.string()),
      body: z.object({
        source: z.literal("saved"),
        workflow_id: z.string().uuid(),
        input: JsonObject,
      }),
      snippets: z.object({ dev: Snippets, prod: Snippets }).nullable(),
    }),
    visibility: z
      .object({ hooks: z.boolean(), schedules: z.boolean() })
      .describe(
        "Whether this caller may read the workflow's inbound hooks (`inbound_hook:read`) and schedules (`schedule:read`). When false the list is ABSENT, which is not the same as empty: the workflow may well have hooks or schedules this caller cannot see, so nothing about them — that there are none, or that all are approved — can be concluded.",
      ),
    hooks: z
      .array(
        z.object({
          slug: z.string(),
          path: z.string(),
          url: z.string().nullable(),
          verifier: z.string(),
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
          environment: z.literal("prod"),
        }),
      )
      .optional()
      .describe(
        "The workflow's inbound hooks. Present — possibly empty — only when `visibility.hooks` is true.",
      ),
    mcp: z.object({
      tool_name: z
        .string()
        .describe(
          "The name this workflow's own tool has WHEN the MCP catalog publishes it. Not every saved workflow is published to every client: the catalog depends on the caller's permissions and mode and lists a bounded number of workflow tools. `fallback` works either way.",
        ),
      fallback: z.object({
        tool_name: z.string(),
        arguments: z.object({ workflow: z.string(), input: JsonObject }),
      }),
    }),
    schedules: z
      .array(
        z.object({
          cron: z.string(),
          timezone: z.string(),
          environment: Environment,
          input: z.unknown(),
          state: z.enum(["active", "paused", "held", "activation_required"]),
          next_fire_at: z.string().nullable(),
        }),
      )
      .optional()
      .describe(
        "The workflow's schedules. Present — possibly empty — only when `visibility.schedules` is true.",
      ),
    cli: z.object({
      command: z.string(),
      environment: Environment,
    }),
    input: z.object({
      source: z.enum(["declared", "synthesized", "none"]),
      schema: JsonObject.nullable(),
      sample: JsonObject,
    }),
    output: z.object({ schema: JsonObject.nullable() }),
    webhook_input_shape: z.record(z.string(), z.string()),
    authority: z.object({ dev: RunAuthority, prod: RunAuthority }),
    start_access: z
      .object({
        permission: z.literal("workflow:run"),
        caller: z.object({
          allowed: z.boolean(),
          source: z.string().nullable(),
          reason: z.string().nullable(),
        }),
        visibility: z.object({ rules: z.boolean() }),
        rules: z
          .object({
            roles: z.array(z.object({ id: z.string(), name: z.string() })),
            grants: z.array(
              z.object({
                subject_type: z.enum(["user", "system_account", "group"]),
                subject_id: z.string(),
                expires_at: z.string().nullable(),
              }),
            ),
          })
          .optional()
          .describe(
            "Configured roles and unexpired grants for this workflow, visible only with rbac:read. These rules do not establish an authenticated caller or bypass credential restrictions, account state, or effect admission.",
          ),
        external: z.object({
          authentication_required: z.literal(true),
          credential_restrictions_apply: z.literal(true),
        }),
        without_approval: z.literal("held_preview_only"),
      })
      .describe(
        "Current caller's workflow:run permission evaluated with credential ceilings; not an effect approval or a guarantee that a run is admitted. External authenticated callers need this permission too. Inbound hooks have their separately configured verifiers and are listed under hooks.",
      ),
  })
  .openapi("WorkflowInvocation");

const invocationRoute = createRoute({
  method: "get",
  path: "/v1/workflows/{id}/invocation",
  tags: ["workflows"],
  summary: "How to call this workflow: HTTP, inbound hooks, MCP, schedules and CLI",
  description:
    "Everything a caller needs to run the saved workflow, in one read: the run request (`POST /v1/executions`) with header names, an example body and ready-to-paste snippets; its inbound hooks with their signing scheme; the MCP tool name it has when the catalog publishes it, and the `run_workflow` call that works regardless; its schedules; the CLI command; the input and output schema with a sample input; and, per environment, whether an approval for the running version exists (`authority` — advisory; admission decides). `http.url`, `hooks[].url` and `http.snippets` are null until `server.public_base_url` is configured. `hooks` and `schedules` are present only when the caller holds `inbound_hook:read` and `schedule:read`; `visibility` says which, so an absent list is never mistaken for an empty one. Carries no credential: header names only, never a key or a signing secret.",
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

function publicBaseUrl(): string | null {
  const configured = getConfig().server.public_base_url?.trim();
  return configured ? configured.replace(/\/+$/, "") : null;
}

const PLAIN_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function cliRunCommand(
  workflow: { id: string; slug: string },
  input: Record<string, unknown>,
): string {
  const name = PLAIN_SLUG.test(workflow.slug) ? workflow.slug : workflow.id;
  return `sk workflows run ${name} --input ${shellQuote(JSON.stringify(input))}`;
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

    const [hooks, schedules, authority, startAccess] = await Promise.all([
      mayHooks ? listWorkflowInboundHooks(tenant, workflow.id, db) : null,
      maySchedules ? listSchedules(db, tenant, workflow.id) : null,
      workflowRunAuthority(db, workflow),
      workflowStartAccess(db, principal, workflow.id, new Date(now)),
    ]);

    return c.json(
      {
        workflow_id: workflow.id,
        slug: workflow.slug,
        invalid: workflow.invalid,
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
        visibility: { hooks: mayHooks, schedules: maySchedules },
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
          command: cliRunCommand(workflow, sample),
          environment: "dev" as const,
        },
        input: { ...input, sample },
        output: { schema: workflow.definition.output_schema ?? null },
        webhook_input_shape: { ...WEBHOOK_INPUT_SHAPE },
        authority,
        start_access: startAccess,
      },
      200,
    );
  });
}
