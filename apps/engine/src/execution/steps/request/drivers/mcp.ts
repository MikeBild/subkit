import { invokeMcpConnectorCall, mcpEgressInput } from "../../../../connectors/drivers/mcp.ts";
import { withEgressAudit } from "../../../../connectors/egress.ts";
import { clearReauthIfProved } from "../../../../connectors/reauth.ts";
import type { RemoteToolDescriptor } from "../../../../mcp/client/manifest.ts";
import { MCP_WIRE_METHOD, type RemoteCall } from "../../../../mcp/client/remote-call.ts";
import {
  describeMcpBoundaryViolation,
  mcpArgumentsViolation,
  mcpBoundary,
  mcpToolDescriptorPin,
} from "../../../../workflows/mcp-boundary.ts";
import { GOVERNANCE_REFUSALS } from "../../../state.ts";
import type { ConnectorResolutionSummary, StepResult } from "../../../types.ts";
import { buildStepErrorDetail } from "../../error-detail.ts";
import { mcpEvidence } from "../circuit-evidence.ts";
import { runMcpWithRetry } from "../mcp-retry.ts";
import { resolveRetryPolicy } from "../retry.ts";
import { classifyRequestStepSideEffects, heldStepResult } from "../side-effects.ts";
import {
  egressScope,
  failedStep,
  type RequestDispatch,
  type RequestStepDriver,
  recordDriverOutcome,
  requireConnector,
} from "./context.ts";

class McpAuthorityRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpAuthorityRefusal";
  }
}

function outsideDeclaredBoundary(detail: string): string {
  return (
    `This tool call is outside the boundary its step declares: ${detail}. Nothing was sent. ` +
    "Correct `mcp.boundary` on this step so it covers the call, or correct the arguments; do " +
    "not remove the boundary."
  );
}

async function executeMcp(d: RequestDispatch): Promise<StepResult> {
  const { p } = d;
  const connector = requireConnector(d);
  const connectorMeta = d.connector_resolution as ConnectorResolutionSummary;
  if (connector.driver !== "mcp") {
    return failedStep(d, {
      code: "connector_driver_mismatch",
      message: `request step carries an \`mcp\` block but connector '${connector.slug}' is driver '${connector.driver}'`,
    });
  }
  const mcpSpec = p.step.mcp;
  if (!mcpSpec) {
    return failedStep(d, {
      code: "missing_mcp",
      message:
        'request step against an mcp connector requires `protocol: "mcp"` and an `mcp` block naming the operation (call_tool | read_resource | get_prompt)',
    });
  }
  const { mcp_target: mcpTargetRes, mcp_arguments: mcpArgsRes } = d.parts;
  const unresolved = [...(mcpTargetRes?.unresolved ?? []), ...(mcpArgsRes?.unresolved ?? [])];
  if (unresolved.length > 0) {
    const tokens = unresolved.map((u) => u.token).join(", ");
    return failedStep(
      d,
      {
        code: "placeholder_unresolved",
        message: `unresolved placeholder(s) in mcp target/arguments: ${tokens}`,
        details: { unresolved },
      },
      {
        request_meta: {
          driver: "error",
          url: connector.base_url ?? null,
          unresolved_placeholders: unresolved.map((u) => u.token),
        },
      },
    );
  }
  const target = mcpTargetRes?.value ?? "";
  const args = (mcpArgsRes?.value as Record<string, unknown> | undefined) ?? {};
  const call: RemoteCall =
    mcpSpec.operation === "read_resource"
      ? { operation: "read_resource", uri: target }
      : mcpSpec.operation === "get_prompt"
        ? { operation: "get_prompt", prompt: target, arguments: args }
        : { operation: "call_tool", tool: target, arguments: args };
  const wireMethod = MCP_WIRE_METHOD[mcpSpec.operation];
  const declared =
    mcpSpec.operation === "call_tool" && mcpSpec.boundary !== undefined
      ? mcpBoundary(p.step, connector.base_url)
      : null;
  if (declared) {
    const violation = mcpArgumentsViolation(declared, { tool: target, arguments: args });
    if (violation)
      return failedStep(d, {
        code: "request_outside_declared_boundary",
        message: outsideDeclaredBoundary(describeMcpBoundaryViolation(violation)),
      });
  }

  if (d.state.holdThisStep) {
    return heldStepResult({
      start: d.start,
      clock: d.clock,
      method: wireMethod,
      url: connector.base_url ?? null,
      body: { target, ...(mcpSpec.operation === "read_resource" ? {} : { arguments: args }) },
    });
  }

  try {
    const {
      executor,
      tenant_id,
      actor_type,
      actor_id,
      source,
      execution_id,
      workflow_id,
      step_id,
    } = egressScope(d);
    const admit = async (listed: RemoteToolDescriptor | null): Promise<void> => {
      const snapshot = {
        ...d.authority_snapshot(),
        mcp_dispatch: {
          operation: mcpSpec.operation,
          ...(mcpSpec.operation === "call_tool"
            ? {
                call: {
                  tool: target,
                  arguments: args,
                  descriptor: listed ? mcpToolDescriptorPin(listed) : null,
                },
              }
            : {}),
        },
      };
      try {
        await p.ctx.before_external_request?.(snapshot);
      } catch (error) {
        const reason = (error as { code?: unknown }).code;
        const code = typeof reason === "string" ? reason : "authority_check_failed";
        throw new McpAuthorityRefusal(
          GOVERNANCE_REFUSALS.has(code) ? code : "authority_invalid",
          `Execution authority could not be verified: ${code}; review the current boundary.`,
        );
      }
    };
    const result = await runMcpWithRetry({
      attempt: () =>
        withEgressAudit(
          mcpEgressInput({
            executor,
            tenant_id,
            actor_type,
            actor_id,
            connector: {
              id: connector.id,
              slug: connector.slug,
              url: connector.base_url ?? null,
            },
            call,
            source,
            execution_id,
            workflow_id,
            step_id,
          }),
          () =>
            invokeMcpConnectorCall({
              before_call: admit,
              on_dispatch: () => d.record_effect(classifyRequestStepSideEffects(p.step)),
              on_credential_use: d.persist_credential_use,
              db: p.ctx.db,
              tenant_id: p.ctx.tenant_id,
              actor_type,
              actor_id,
              connector,
              call,
              requestSource: p.ctx.request_source,
              signal: d.signal,
            }),
        ),
      step: p.step,
      signal: d.signal,
      start: d.start,
      clock: d.clock,
      connector: connectorMeta,
      operation: wireMethod,
      connector_id: connector.id,
    });
    await recordDriverOutcome(p.ctx.db, connector, mcpEvidence(result));
    if (result.status === "succeeded") {
      await clearReauthIfProved(p.ctx.db, connector, {
        status: 200,
        health: "ok",
        stored_credential_used: true,
      });
    }
    return result;
  } catch (err) {
    if (err instanceof McpAuthorityRefusal)
      return failedStep(d, { code: err.code, message: err.message });
    return failedStep(d, buildStepErrorDetail({ code: "mcp_step_invalid", err }));
  }
}

export const mcpRequestDriver: RequestStepDriver & { readonly kind: "mcp" } = {
  kind: "mcp",
  capabilities: {
    retry: "mcp_availability",
    pagination: "none",
    response_filters: "result",
    circuit_close: "outcome",
    step_timer: false,
    owns_setup_errors: false,
    failure_code: "mcp_step_invalid",
  },
  retryPolicy: resolveRetryPolicy,
  classifySideEffects: (step, method, baseUrl) =>
    classifyRequestStepSideEffects(step, "mcp", method, baseUrl),
  execute: executeMcp,
};
