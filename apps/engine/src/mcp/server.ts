// MCP server factory.
//
// Builds a fresh `Server` instance per transport session. Each connection
// owns its own server because the request handlers close over the caller's
// principal — this keeps tenant isolation local and avoids a shared
// principal cache.

import { VERSION } from "@cli-core/version.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ElicitResultSchema as McpElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { listElicitationsForConversation } from "../conversations/elicitations.ts";
import { registerNativeUrlElicitationCompletion } from "../conversations/native-url-elicitation.ts";
import type { Db } from "../db/client.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { buildOperatorHealthSummary } from "../operator/health-digest.ts";
import { can } from "../rbac/evaluator.ts";
import { registerCompletionCapability } from "./capabilities/completion.ts";
import { ELICITATION_FORM_TIMEOUT_MS } from "./capabilities/conversation-native-elicitation.ts";
import { deliverPendingNativeElicitation } from "./capabilities/conversations.ts";
import { registerPromptsCapability } from "./capabilities/prompts.ts";
import { registerResourcesCapability } from "./capabilities/resources.ts";
import { registerToolsCapability } from "./capabilities/tools.ts";
import { resolveMcpMode } from "./mode-resolver.ts";
import { ConversationTaskStore } from "./tasks/task-store.ts";

export interface CreateMcpServerParams {
  db: Db;
  principal: ResolvedPrincipal;
  transport: "http" | "stdio";
}

// Compile-time `VERSION` is the real serverInfo.version unless the build
// never stamped one (`0.0.0-dev` placeholder), in which case fall back to the
// runtime `ENGINE_VERSION` so a client's version-skew banner reads the engine
// the operator actually deployed. Mirrors the HTTP OpenAPI resolver.
function resolveEngineVersion(): string {
  if (VERSION && VERSION !== "0.0.0-dev") return VERSION;
  const env = process.env.ENGINE_VERSION;
  if (env && env !== "0.0.0-dev") return env;
  return VERSION ?? "0.0.0-dev";
}

// Connect introduction handed to every principal via the SDK `initialize`
// `instructions` field. The tenant-specific operator health digest is appended
// only when the caller holds `stats:read` (see the gated assembly below).
//
// TIER-DEPENDENT, because authoring is opt-in per credential. It used to open
// with "Start with `conversation_start`" for everyone — including credentials
// that do not carry `mcp:authoring` and therefore cannot call it. Naming a tool
// the caller does not have is worse than saying nothing: the model tries it,
// gets refused, and spends the turn recovering from advice the server gave it.
//
// So the first move named here is one the reader can actually make.
const SHARED_INTRO = [
  "sk runs your business workflows as governed, audited, versioned executions —",
  "every run is permission-checked, recorded, and replayable.",
];

const CATALOG_AND_GROUNDING = [
  "The catalog itself is grouped: `list_workflows` and `find_workflow` report a `category`",
  "(the block a workflow belongs to) and the `connectors` it uses, and both are filters —",
  "ask for one block, or for everything that touches a given connector.",
  "",
  "Grounding: for questions about the tenant's business domains (conventions, runbooks,",
  "internal APIs), call `search_knowledge_v2` FIRST and answer from the hits — do not",
  "answer from prior knowledge. If the search returns nothing, say so instead of guessing.",
];

/** The intro for a credential that may author over MCP. */
const AUTHORING_INTRO = [
  ...SHARED_INTRO,
  "",
  "Start with `conversation_start`: describe the outcome you want in plain language",
  "and sk turns it into a runnable, governed workflow.",
  "",
  "Tools are grouped into workflow tools (find, inspect, and run your workflows) and",
  "conversation/session tools (author, refine, and commit workflows through a guided chat).",
  "",
  ...CATALOG_AND_GROUNDING,
].join("\n");

/** The intro for a read-and-execute credential — the default.
 *
 *  It names the CLI rather than apologising for a missing tool, because that is
 *  where the work actually happens: a definition edit should arrive as a file
 *  someone can read, not as a sentence a second model paraphrased into a patch. */
const READ_EXECUTE_INTRO = [
  ...SHARED_INTRO,
  "",
  "Start by finding what already exists: `find_workflow` to search, `run_workflow` to",
  "execute, `get_execution` to follow a run that outlives the call.",
  "",
  "This credential reads and runs; it does not author. Creating or changing a workflow,",
  "connector, knowledge source or skill happens in the `sk` CLI — `sk workflows --help`,",
  "`sk connectors --help` — where the change is a file that can be reviewed before it",
  "lands. Do not describe an authoring tool you cannot see here; point at the CLI instead.",
  "",
  ...CATALOG_AND_GROUNDING,
].join("\n");

export async function createMcpServer(p: CreateMcpServerParams): Promise<Server> {
  const { db, principal, transport } = p;

  // Per-session, tenant-bound TaskStore backing the MCP async-Tasks
  // surface (SEP-1686). Every conversation tool can be invoked as a
  // task so the `tools/call` returns immediately and the long turn
  // runs in the `conversation.run-turn` pg-boss worker.
  const taskStore = new ConversationTaskStore({ db, tenant_id: principal.tenant_id });

  // Compact health/risk summary handed to the client at connect via the
  // SDK `instructions` field. The server is already tenant-bound through
  // `principal.tenant_id`, so this is the same digest every other surface
  // reads. Best-effort: a digest failure must NEVER fail initialize — a
  // broken health read should not deny the client its tools.
  // The summary exposes cross-workflow operational posture, so it is gated on
  // `stats:read` — the same permission the HTTP route and the MCP resource
  // enforce. A principal without it (e.g. a portal token scoped to one
  // workflow) gets the server's tools but no operator digest in `instructions`.
  // Bounded on the connect hot path: a SLOW Postgres (the exact degradation
  // these signals predict) must not hang `initialize`, so the digest races a
  // short timeout and falls through to no-instructions. Best-effort end to end
  // — a throw, a denied gate, or a timeout never fails initialize.
  const INSTRUCTIONS_TIMEOUT_MS = 400;
  // The intro matches what this credential can actually do; the operator
  // digest is appended on top only when the gate allows and the digest
  // resolves in time.
  const baseIntro = resolveMcpMode(principal) === "product" ? READ_EXECUTE_INTRO : AUTHORING_INTRO;
  let instructions: string = baseIntro;
  try {
    const decision = await can(db, {
      tenant_id: principal.tenant_id,
      principal,
      permission: "stats:read",
      // this is a capability PROBE run on every MCP connect to decide
      // whether to attach the operator digest to `initialize`; a user without
      // stats:read is normal, not an incident. Mark it quiet so it logs at
      // DEBUG instead of emitting an `rbac.denied` WARN on every connection
      // (52×/day in prod), which drowned out real denials.
      quiet: true,
    });
    if (decision.allow) {
      // If the timeout wins the race the digest query keeps running; map its
      // eventual result/error through a single handler so it neither leaks an
      // unhandled rejection nor silently drops (it held a DB connection on the
      // hot path — worth a log under the very saturation this predicts).
      const digestText = buildOperatorHealthSummary(db, principal.tenant_id).then(
        (s) => s.text,
        (err) => {
          logger.warn({
            module: "mcp",
            action: "mcp.instructions.late_error",
            msg: "connect health summary failed (after the initialize race resolved)",
            tenant_id: principal.tenant_id,
            ...errorFields(err),
          });
          return null;
        },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const text = await Promise.race([
        digestText,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), INSTRUCTIONS_TIMEOUT_MS);
          (timer as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (text) {
        instructions = `${baseIntro}\n\n${text}`;
      } else {
        logger.warn({
          module: "mcp",
          action: "mcp.instructions.skipped",
          msg: `connect health summary exceeded ${INSTRUCTIONS_TIMEOUT_MS}ms — proceeding with base intro only`,
          tenant_id: principal.tenant_id,
        });
      }
    }
  } catch (err) {
    logger.warn({
      module: "mcp",
      action: "mcp.instructions.skipped",
      msg: "could not compute connect health summary — proceeding with base intro only",
      tenant_id: principal.tenant_id,
      ...errorFields(err),
    });
  }

  // TODO(mcp-spec): add `icons` (SEP-973) to serverInfo — and to the core
  // tools/prompts — once the engine serves a real sk brand asset (SVG/PNG).
  // The SDK 1.29 Implementation shape supports it; not adding a fabricated
  // data-URI. Improves client catalog UX in claude.ai / ChatGPT.
  const server = new Server(
    {
      name: "subkit-engine",
      title: "sk",
      version: resolveEngineVersion(),
      description:
        "Run your business workflows as governed, audited, versioned executions — " +
        "every run permission-checked, recorded, and replayable. Describe an outcome " +
        "in plain language and sk turns it into a runnable, governed workflow.",
    },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true },
        prompts: {},
        // Tasks: list + cancel + task-augmented `tools/call`. The SDK
        // installs the tasks/get|result|list|cancel handlers when a
        // `taskStore` is supplied; this capability advertises them to
        // the client during initialize.
        tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
      },
      taskStore,
      ...(instructions ? { instructions } : {}),
    },
  );

  taskStore.setInputRequiredHandler(async (task) => {
    const capabilities = server.getClientCapabilities()?.elicitation;
    const formCapable =
      capabilities !== undefined &&
      (capabilities.form !== undefined || capabilities.url === undefined);
    const urlCapable = capabilities?.url !== undefined;
    if (!formCapable && !urlCapable) return false;
    const pending = (
      await listElicitationsForConversation(principal.tenant_id, task.conversation_id, db)
    ).find((row) => row.status === "pending");
    if (!pending) return false;
    await deliverPendingNativeElicitation({
      db,
      principal,
      pending,
      reuse_task_id: task.id,
      nativeElicitation: {
        ...(formCapable
          ? {
              elicitForm: async (params) =>
                await server.request(
                  { method: "elicitation/create", params: { mode: "form", ...params } },
                  McpElicitResultSchema,
                  { timeout: ELICITATION_FORM_TIMEOUT_MS },
                ),
            }
          : {}),
        ...(urlCapable
          ? {
              elicitUrl: async (params) => {
                const unregister = registerNativeUrlElicitationCompletion(
                  params.elicitationId,
                  server.createElicitationCompletionNotifier(params.elicitationId),
                );
                try {
                  const result = await server.request(
                    {
                      method: "elicitation/create",
                      params: {
                        ...params,
                        _meta: { "io.modelcontextprotocol/related-task": { taskId: task.id } },
                      },
                    },
                    McpElicitResultSchema,
                    { timeout: ELICITATION_FORM_TIMEOUT_MS },
                  );
                  if (result.action !== "accept") unregister();
                  return result;
                } catch (err) {
                  unregister();
                  throw err;
                }
              },
            }
          : {}),
      },
    });
    return true;
  });

  registerToolsCapability({ server, db, principal, transport });
  registerResourcesCapability({ server, db, principal });
  registerPromptsCapability({ server, db, principal });
  registerCompletionCapability({ server, db, principal });

  logger.info({
    module: "mcp",
    action: "mcp.connected",
    msg: "mcp server assembled",
    transport,
    principal_id: principal.id,
    tenant_id: principal.tenant_id,
  });

  return server;
}
