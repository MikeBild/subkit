// MCP server factory.
//
// Builds a fresh `Server` instance per transport session. Each connection
// owns its own server because the request handlers close over the caller's
// principal — this keeps tenant isolation local and avoids a shared
// principal cache.

import { VERSION } from "@cli-core/version.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { buildOperatorHealthSummary } from "../operator/health-digest.ts";
import { can } from "../rbac/evaluator.ts";
import { registerCompletionCapability } from "./capabilities/completion.ts";
import { registerPromptsCapability } from "./capabilities/prompts.ts";
import { registerResourcesCapability } from "./capabilities/resources.ts";
import { registerToolsCapability } from "./capabilities/tools.ts";
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

// Always-present connect introduction handed to every principal via the SDK
// `initialize` `instructions` field. Principal-independent (no tenant data),
// so it is a module const built once. Leads with the operator outcome sk
// delivers, names the canonical first move, and sketches how the tools are
// grouped. The tenant-specific operator health digest is appended only when
// the caller holds `stats:read` (see the gated assembly below).
const BASE_INTRO = [
  "sk runs your business workflows as governed, audited, versioned executions —",
  "every run is permission-checked, recorded, and replayable.",
  "",
  "Start with `conversation_start`: describe the outcome you want in plain language",
  "and sk turns it into a runnable, governed workflow.",
  "",
  "Tools are grouped into workflow tools (find, inspect, and run your workflows) and",
  "conversation/session tools (author, refine, and commit workflows through a guided chat).",
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
  // Every principal gets the base intro; the operator digest is appended on
  // top only when the gate allows and the digest resolves in time.
  let instructions: string = BASE_INTRO;
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
        instructions = `${BASE_INTRO}\n\n${text}`;
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
