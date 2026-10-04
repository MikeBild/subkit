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

function resolveEngineVersion(): string {
  if (VERSION && VERSION !== "0.0.0-dev") return VERSION;
  const env = process.env.ENGINE_VERSION;
  if (env && env !== "0.0.0-dev") return env;
  return VERSION ?? "0.0.0-dev";
}

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
  "internal APIs), call `search_knowledge` FIRST and answer from the hits — do not",
  "answer from prior knowledge. If the search returns nothing, say so instead of guessing.",
];

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

  const taskStore = new ConversationTaskStore({ db, tenant_id: principal.tenant_id });

  const INSTRUCTIONS_TIMEOUT_MS = 400;
  const baseIntro = resolveMcpMode(principal) === "product" ? READ_EXECUTE_INTRO : AUTHORING_INTRO;
  let instructions: string = baseIntro;
  try {
    const decision = await can(db, {
      tenant_id: principal.tenant_id,
      principal,
      permission: "stats:read",
      quiet: true,
    });
    if (decision.allow) {
      const digestText = buildOperatorHealthSummary(db, principal).then(
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
