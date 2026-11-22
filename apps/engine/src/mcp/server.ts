import { VERSION } from "@cli-core/version.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ElicitResultSchema as McpElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CatalogKind } from "../api/catalog-metadata.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import {
  listElicitationsForConversation,
  registerNativeUrlElicitationCompletion,
} from "../conversations/public/elicitation.ts";
import type { Db } from "../db/client.ts";
import { readEnv } from "../env.ts";
import { errorFields, logger } from "../logging/index.ts";
import { buildOperatorHealthSummary } from "../operator/health-digest.ts";
import { can } from "../rbac/evaluator.ts";
import { buildCatalogSummaryLine } from "../workflows/catalog-view.ts";
import { registerCompletionCapability } from "./capabilities/completion.ts";
import { ELICITATION_FORM_TIMEOUT_MS } from "./capabilities/conversation-native-elicitation.ts";
import { deliverPendingNativeElicitation } from "./capabilities/conversations.ts";
import { registerPromptsCapability } from "./capabilities/prompts.ts";
import { registerResourcesCapability } from "./capabilities/resources.ts";
import { registerToolsCapability } from "./capabilities/tools.ts";
import { resolveMcpMode } from "./mode-resolver.ts";
import { ConversationTaskStore } from "./tasks/task-store.ts";

interface CreateMcpServerParams {
  db: Db;
  principal: ResolvedPrincipal;
  transport: "http" | "stdio";
}

function resolveEngineVersion(): string {
  if (VERSION && VERSION !== "0.0.0-dev") return VERSION;
  const env = readEnv("ENGINE_VERSION");
  if (env && env !== "0.0.0-dev") return env;
  return VERSION ?? "0.0.0-dev";
}

const SHARED_INTRO = [
  "subkit runs your business workflows as governed, audited, versioned executions —",
  "every run is permission-checked, recorded, and replayable.",
];

const CATALOG_AND_GROUNDING = [
  "Workflows, connectors, knowledge sources, skills, files and tasks carry a `description` (what",
  "each is for, when known) and a `category` (the catalog block it belongs to, one vocabulary",
  "for all of them). `list_*` and `find_*` return both and take `category` as a filter; `find_*` ranks",
  "by category, name and description and says why each match matched. Only the most",
  "recently used workflows appear as `wf_<slug>` tools — `find_workflow` reaches every one.",
  "",
  "Grounding: for questions about the tenant's business domains (conventions, runbooks,",
  "internal APIs), call `search_knowledge` FIRST and answer from the hits — do not",
  "answer from prior knowledge. If the search returns nothing, say so instead of guessing.",
];

const AUTHORING_INTRO = [
  ...SHARED_INTRO,
  "",
  "Start with `conversation_start`: describe the outcome you want in plain language",
  "and subkit turns it into a runnable, governed workflow.",
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
  "connector, knowledge source or skill happens in the `subkit` CLI — `subkit workflows --help`,",
  "`subkit connectors --help` — where the change is a file that can be reviewed before it",
  "lands. Do not describe an authoring tool you cannot see here; point at the CLI instead.",
  "",
  ...CATALOG_AND_GROUNDING,
].join("\n");

async function raceWithin<T>(work: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    work,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
      (timer as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

const CATALOG_READ_PERMISSIONS = [
  ["workflow", "workflow:read"],
  ["connector", "connector:read"],
  ["knowledge_source", "knowledge:read"],
  ["task", "task:read"],
] as const;

async function readableCatalogKinds(
  db: CreateMcpServerParams["db"],
  principal: CreateMcpServerParams["principal"],
): Promise<Set<CatalogKind>> {
  const readable = new Set<CatalogKind>();
  for (const [kind, permission] of CATALOG_READ_PERMISSIONS) {
    const decision = await can(db, {
      tenant_id: principal.tenant_id,
      principal,
      permission,
      quiet: true,
    });
    if (decision.allow) readable.add(kind);
  }
  return readable;
}

async function connectHealthSummary(
  db: CreateMcpServerParams["db"],
  principal: CreateMcpServerParams["principal"],
  timeoutMs: number,
): Promise<string | null> {
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
      const text = await raceWithin(digestText, timeoutMs);
      if (text) return text;
      logger.warn({
        module: "mcp",
        action: "mcp.instructions.skipped",
        msg: `connect health summary exceeded ${timeoutMs}ms — proceeding with base intro only`,
        tenant_id: principal.tenant_id,
      });
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
  return null;
}

export async function createMcpServer(p: CreateMcpServerParams): Promise<Server> {
  const { db, principal, transport } = p;

  const taskStore = new ConversationTaskStore({ db, tenant_id: principal.tenant_id, principal });

  const INSTRUCTIONS_TIMEOUT_MS = 400;
  const intro = resolveMcpMode(principal) === "product" ? READ_EXECUTE_INTRO : AUTHORING_INTRO;
  const catalogLine = raceWithin(
    readableCatalogKinds(db, principal)
      .then((readable) => buildCatalogSummaryLine(principal.tenant_id, readable, db))
      .catch((err) => {
        logger.warn({
          module: "mcp",
          action: "mcp.instructions.catalog_skipped",
          msg: "could not compute the catalog summary line — proceeding without it",
          tenant_id: principal.tenant_id,
          ...errorFields(err),
        });
        return null;
      }),
    INSTRUCTIONS_TIMEOUT_MS,
  );
  const healthText = connectHealthSummary(db, principal, INSTRUCTIONS_TIMEOUT_MS);
  const [catalog, health] = await Promise.all([catalogLine, healthText]);
  const instructions = [catalog ? `${intro}\n${catalog}` : intro, health]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");

  const server = new Server(
    {
      name: "subkit-engine",
      title: "subkit",
      version: resolveEngineVersion(),
      description:
        "Run your business workflows as governed, audited, versioned executions — " +
        "every run permission-checked, recorded, and replayable. Describe an outcome " +
        "in plain language and subkit turns it into a runnable, governed workflow.",
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
