import type { McpClientLike } from "../../mcp/client/pool.ts";
import { waitFor } from "../../test-helpers/determinism/index.ts";
import { runExecution } from "../engine.ts";
import { createWorkflowRow, type EngineTestCtx } from "./setup.ts";

export const SLUG = "mcpstep";

const DEFAULT_CONTENT = [{ type: "text", text: "ok" }];

function abortError(): Error {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

export function mcpRequestStepFixtures(state: {
  readonly connectorId: string;
  readonly ctx: EngineTestCtx;
}) {
  const remote = {
    toolCalls: [] as Array<{ name: string; arguments: Record<string, unknown> | undefined }>,
    resourceReads: [] as string[],
    promptGets: [] as Array<{ name: string; arguments: Record<string, string> | undefined }>,
    toolCallTimeouts: [] as Array<number | undefined>,
    throwTimes: 0,
    throwForQuery: new Map<string, number>(),
    isError: false,
    isErrorForQuery: new Set<string>(),
    content: DEFAULT_CONTENT as unknown,
    structured: undefined as unknown,
    hasStructured: false,
    parkUntilAborted: false,
    abortedCalls: 0,
    closes: 0,
    inFlight: 0,
    peakInFlight: 0,
    rendezvous: 0,
  };

  function resetRemote(): void {
    remote.toolCalls = [];
    remote.toolCallTimeouts = [];
    remote.resourceReads = [];
    remote.promptGets = [];
    remote.throwTimes = 0;
    remote.throwForQuery = new Map();
    remote.isError = false;
    remote.isErrorForQuery = new Set();
    remote.content = DEFAULT_CONTENT;
    remote.structured = undefined;
    remote.hasStructured = false;
    remote.parkUntilAborted = false;
    remote.abortedCalls = 0;
    remote.closes = 0;
    remote.inFlight = 0;
    remote.peakInFlight = 0;
    remote.rendezvous = 0;
  }

  async function enterCall(signal: AbortSignal | undefined): Promise<void> {
    remote.inFlight += 1;
    remote.peakInFlight = Math.max(remote.peakInFlight, remote.inFlight);
    if (remote.rendezvous > 1) {
      try {
        await waitFor(() => remote.inFlight >= remote.rendezvous, {
          tries: 60,
          sleepMs: 5,
          label: "mcp fan-out rendezvous",
        });
      } catch {}
    }
    if (!remote.parkUntilAborted) return;
    if (!signal) throw new Error("no abort signal was threaded to the outbound call");
    await new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        remote.abortedCalls += 1;
        reject(abortError());
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          remote.abortedCalls += 1;
          reject(abortError());
        },
        { once: true },
      );
    });
  }

  const fakeClient: McpClientLike = {
    async connect() {},
    async listTools() {
      return {
        tools: [{ name: "search", description: "search", inputSchema: { type: "object" } }],
      };
    },
    async callTool(params, _resultSchema, options) {
      remote.toolCalls.push({ name: params.name, arguments: params.arguments });
      remote.toolCallTimeouts.push(options?.timeout);
      try {
        await enterCall(options?.signal);
        const q = params.arguments?.q;
        const perQuery = typeof q === "string" ? (remote.throwForQuery.get(q) ?? 0) : 0;
        if (perQuery > 0) {
          remote.throwForQuery.set(q as string, perQuery - 1);
          throw new Error("socket hang up");
        }
        if (remote.throwTimes > 0) {
          remote.throwTimes -= 1;
          throw new Error("socket hang up");
        }
        return {
          content: remote.content,
          isError: remote.isError || (typeof q === "string" && remote.isErrorForQuery.has(q)),
          ...(remote.hasStructured ? { structuredContent: remote.structured } : {}),
        };
      } finally {
        remote.inFlight -= 1;
      }
    },
    async readResource(params, _resultSchema, options) {
      remote.resourceReads.push(params.uri);
      try {
        await enterCall(options?.signal);
        return { contents: [{ uri: params.uri, text: "resource body" }] };
      } finally {
        remote.inFlight -= 1;
      }
    },
    async getPrompt(params, _resultSchema, options) {
      remote.promptGets.push({ name: params.name, arguments: params.arguments });
      try {
        await enterCall(options?.signal);
        return { messages: [{ role: "user", content: { type: "text", text: "prompt body" } }] };
      } finally {
        remote.inFlight -= 1;
      }
    },
    async close() {
      remote.closes += 1;
    },
  };

  async function run(
    name: string,
    step: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): ReturnType<typeof runExecution> {
    return runDef(
      name,
      [{ kind: "request", id: "mcp", connector_id: state.connectorId, ...step }],
      options,
    );
  }

  async function runDef(
    name: string,
    steps: Array<Record<string, unknown>>,
    options?: Record<string, unknown>,
  ): ReturnType<typeof runExecution> {
    const { workflow_id } = await createWorkflowRow(state.ctx, { name, steps });
    return runExecution({
      db: state.ctx.testDb.db,
      tenant_id: state.ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
      ...(options ? { options } : {}),
    });
  }

  return { fakeClient, remote, resetRemote, run, runDef };
}
