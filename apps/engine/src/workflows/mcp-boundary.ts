import { z } from "@hono/zod-openapi";
import { isStdioIdentity } from "@shared/stdio-identity.ts";
import { canonicalWorkflowJson, workflowJsonDigest } from "./canonical-json.ts";
import { hasRuntimeValue } from "./report-delivery-boundary.ts";
import {
  callerRulesConsistent,
  type RequestVariableRule,
  RequestVariableRuleSchema,
  VariableExpressionSchema,
  variablesError,
  variableValueAllowed,
} from "./request-boundary.ts";
import type { RequestStep } from "./types.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const WHOLE_PLACEHOLDER = /^\$\{([^}]+)\}$/;
const MAX_ARGUMENT_DEPTH = 16;

const ToolHintsSchema = z
  .object({
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .strict();
export type McpToolHints = z.infer<typeof ToolHintsSchema>;

export const McpBoundaryScopeSchema = z
  .object({
    effect: z
      .enum(["read", "write"], {
        error:
          "`effect` states what this tool call does, as a person will review it: `read` or " +
          "`write`. Omit it and the call counts as `write`.",
      })
      .optional(),
    variables: z.record(VariableExpressionSchema, RequestVariableRuleSchema, {
      error: variablesError,
    }),
    max_calls: z.number().int().min(1).max(10_000),
    descriptor: z
      .object({
        input_schema_digest: digest,
        annotations: ToolHintsSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type McpBoundaryScope = z.infer<typeof McpBoundaryScopeSchema>;

const ToolDescriptorPinSchema = z
  .object({
    name: z.string().regex(TOOL_NAME),
    annotations: ToolHintsSchema,
    input_schema_digest: digest,
    digest,
  })
  .strict();
export type McpToolDescriptorPin = z.infer<typeof ToolDescriptorPinSchema>;

export const McpBoundarySchema = z
  .object({
    server: z.string().url(),
    tool: z.string().regex(TOOL_NAME),
    effect: z.enum(["read", "write"]),
    variables: z.record(VariableExpressionSchema, RequestVariableRuleSchema),
    arguments: z
      .array(
        z
          .object({
            path: z.array(z.string()).min(1).max(MAX_ARGUMENT_DEPTH),
            var: VariableExpressionSchema,
          })
          .strict(),
      )
      .max(50),
    fixed_arguments_digest: digest,
    max_calls: z.number().int().min(1).max(10_000),
    descriptor: ToolDescriptorPinSchema,
  })
  .strict()
  .refine((boundary) => boundary.descriptor.name === boundary.tool, {
    message: "the pinned tool descriptor must describe the tool this step calls",
  })
  .refine((boundary) => boundary.descriptor.digest === descriptorDigest(boundary.descriptor), {
    message: "the pinned tool descriptor digest does not match its content",
  })
  .refine((boundary) => callerRulesConsistent(boundary.variables), {
    message: "caller.* variables need the rule { caller_bound: true }, and only they may use it",
  })
  .refine(
    (boundary) => {
      const used = boundary.arguments.map((entry) => entry.var);
      const declared = Object.keys(boundary.variables);
      return (
        new Set(used).size === used.length &&
        used.length === declared.length &&
        used.every((name) => declared.includes(name))
      );
    },
    { message: "every argument placeholder needs exactly one variable rule" },
  );
export type McpBoundary = z.infer<typeof McpBoundarySchema>;

export type McpBoundaryRefusal =
  | "mcp_not_a_tool_call"
  | "mcp_no_boundary"
  | "mcp_boundary_invalid"
  | "mcp_tool_not_literal"
  | "mcp_server_unresolved"
  | "mcp_runtime_value_outside_arguments"
  | "mcp_argument_placeholder_unsupported"
  | "mcp_variables_mismatch"
  | "mcp_caller_bound_mismatch"
  | "mcp_write_needs_single_attempt"
  | "mcp_tool_changed"
  | "mcp_tool_unavailable";

function normalizedHints(hints: McpToolHints | undefined): McpToolHints {
  return {
    ...(hints?.readOnlyHint !== undefined ? { readOnlyHint: hints.readOnlyHint } : {}),
    ...(hints?.destructiveHint !== undefined ? { destructiveHint: hints.destructiveHint } : {}),
    ...(hints?.idempotentHint !== undefined ? { idempotentHint: hints.idempotentHint } : {}),
    ...(hints?.openWorldHint !== undefined ? { openWorldHint: hints.openWorldHint } : {}),
  };
}

function descriptorDigest(pin: {
  name: string;
  annotations: McpToolHints;
  input_schema_digest: string;
}): string {
  return workflowJsonDigest({
    name: pin.name,
    annotations: normalizedHints(pin.annotations),
    input_schema_digest: pin.input_schema_digest,
  });
}

export function mcpToolDescriptorPin(tool: {
  name: string;
  inputSchema: unknown;
  annotations?: McpToolHints | undefined;
}): McpToolDescriptorPin {
  const pin = {
    name: tool.name,
    annotations: normalizedHints(tool.annotations),
    input_schema_digest: workflowJsonDigest(tool.inputSchema),
  };
  return { ...pin, digest: descriptorDigest(pin) };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type ArgumentPosition = { path: string[]; var: string };

function templateOf(
  value: unknown,
  path: string[],
  positions: ArgumentPosition[],
): { ok: true; fixed: unknown } | { ok: false } {
  if (typeof value === "string") {
    const whole = WHOLE_PLACEHOLDER.exec(value);
    if (whole?.[1] !== undefined && VariableExpressionSchema.safeParse(whole[1]).success) {
      if (path.length === 0 || path.length > MAX_ARGUMENT_DEPTH) return { ok: false };
      positions.push({ path, var: whole[1] });
      return { ok: true, fixed: null };
    }
    return value.includes("${") ? { ok: false } : { ok: true, fixed: value };
  }
  if (Array.isArray(value)) {
    const fixed: unknown[] = [];
    for (const [index, entry] of value.entries()) {
      const inner = templateOf(entry, [...path, String(index)], positions);
      if (!inner.ok) return inner;
      fixed.push(inner.fixed);
    }
    return { ok: true, fixed };
  }
  if (isPlainRecord(value)) {
    const fixed: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key.includes("${")) return { ok: false };
      const inner = templateOf(entry, [...path, key], positions);
      if (!inner.ok) return inner;
      fixed[key] = inner.fixed;
    }
    return { ok: true, fixed };
  }
  return { ok: true, fixed: value };
}

function refuse(refusal: McpBoundaryRefusal) {
  return { refusal } as const;
}

function serverOf(server_url: string | null | undefined): string | null {
  if (!server_url) return null;
  if (isStdioIdentity(server_url)) return server_url;
  try {
    const url = new URL(server_url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

export function compileMcpBoundary(
  step: RequestStep,
  server_url: string | null | undefined,
): { boundary: McpBoundary; refusal?: never } | { boundary?: never; refusal: McpBoundaryRefusal } {
  const call = step.mcp;
  if (call?.operation !== "call_tool" || call.tool === undefined)
    return refuse("mcp_not_a_tool_call");
  if (call.boundary === undefined) return refuse("mcp_no_boundary");
  const scope = McpBoundaryScopeSchema.safeParse(call.boundary);
  if (!scope.success) return refuse("mcp_boundary_invalid");
  if (!TOOL_NAME.test(call.tool) || call.tool.includes("__")) return refuse("mcp_tool_not_literal");
  const { mcp: _mcp, for_each: _forEach, data_selector: _dataSelector, ...fixedStep } = step;
  const { arguments: authored, ...fixedCall } = call;
  if (hasRuntimeValue(fixedStep) || hasRuntimeValue(fixedCall))
    return refuse("mcp_runtime_value_outside_arguments");
  const positions: ArgumentPosition[] = [];
  const template = templateOf(authored ?? {}, [], positions);
  if (!template.ok) return refuse("mcp_argument_placeholder_unsupported");
  const used = positions.map((entry) => entry.var);
  const declared = Object.keys(scope.data.variables);
  if (
    new Set(used).size !== used.length ||
    used.length !== declared.length ||
    used.some((name) => !declared.includes(name))
  )
    return refuse("mcp_variables_mismatch");
  if (!callerRulesConsistent(scope.data.variables)) return refuse("mcp_caller_bound_mismatch");
  if (
    Object.values(scope.data.variables).some((entry) => "class" in entry && entry.class === "path")
  )
    return refuse("mcp_boundary_invalid");
  if ((scope.data.effect ?? "write") === "write" && step.max_retries !== 0)
    return refuse("mcp_write_needs_single_attempt");
  const server = serverOf(server_url);
  if (!server) return refuse("mcp_server_unresolved");
  const pin = {
    name: call.tool,
    annotations: normalizedHints(scope.data.descriptor.annotations),
    input_schema_digest: scope.data.descriptor.input_schema_digest,
  };
  const candidate = McpBoundarySchema.safeParse({
    server,
    tool: call.tool,
    effect: scope.data.effect ?? "write",
    variables: scope.data.variables,
    arguments: positions.sort((a, b) => {
      const left = canonicalWorkflowJson(a.path);
      const right = canonicalWorkflowJson(b.path);
      return left < right ? -1 : left > right ? 1 : 0;
    }),
    fixed_arguments_digest: workflowJsonDigest(template.fixed),
    max_calls: scope.data.max_calls,
    descriptor: { ...pin, digest: descriptorDigest(pin) },
  });
  return candidate.success ? { boundary: candidate.data } : refuse("mcp_boundary_invalid");
}

export function mcpBoundary(
  step: RequestStep,
  server_url: string | null | undefined,
): McpBoundary | null {
  return compileMcpBoundary(step, server_url).boundary ?? null;
}

export function mcpBoundaryTarget(boundary: McpBoundary): string {
  return `${boundary.server}#${boundary.tool}`;
}

export const McpToolCallSchema = z
  .object({
    tool: z.string(),
    arguments: z.unknown(),
    descriptor: ToolDescriptorPinSchema.nullable(),
  })
  .strict();
export type McpToolCall = z.infer<typeof McpToolCallSchema>;

export type McpBoundaryViolation =
  | {
      kind: "boundary_invalid" | "tool" | "arguments" | "descriptor_missing" | "descriptor_changed";
    }
  | { kind: "argument_value"; path: string; rule: string };

function ruleName(rule: RequestVariableRule | undefined): string {
  if (!rule) return "no rule";
  if ("enum" in rule) return `enum of ${rule.enum.length} value(s)`;
  return "caller_bound" in rule ? "the authenticated caller" : `class ${rule.class}`;
}

function takeArgument(root: unknown, path: readonly string[]): { found: boolean; value?: unknown } {
  let holder: unknown = root;
  for (const [depth, key] of path.entries()) {
    const last = depth === path.length - 1;
    if (Array.isArray(holder)) {
      const index = Number(key);
      if (!/^(0|[1-9][0-9]*)$/.test(key) || index >= holder.length) return { found: false };
      if (last) {
        const value = holder[index];
        holder[index] = null;
        return { found: true, value };
      }
      holder = holder[index];
    } else if (isPlainRecord(holder)) {
      if (!Object.hasOwn(holder, key)) return { found: false };
      if (last) {
        const value = holder[key];
        holder[key] = null;
        return { found: true, value };
      }
      holder = holder[key];
    } else return { found: false };
  }
  return { found: false };
}

function argumentText(value: unknown): string | null {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
}

export function mcpArgumentsViolation(
  boundary: McpBoundary,
  call: Pick<McpToolCall, "tool" | "arguments">,
): McpBoundaryViolation | null {
  const parsed = McpBoundarySchema.safeParse(boundary);
  if (!parsed.success) return { kind: "boundary_invalid" };
  const reviewed = parsed.data;
  if (call.tool !== reviewed.tool) return { kind: "tool" };
  if (!isPlainRecord(call.arguments)) return { kind: "arguments" };
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(call.arguments));
  } catch {
    return { kind: "arguments" };
  }
  for (const position of reviewed.arguments) {
    const taken = takeArgument(copy, position.path);
    const rule = reviewed.variables[position.var];
    const text = taken.found ? argumentText(taken.value) : null;
    if (text === null || !variableValueAllowed(rule, text))
      return { kind: "argument_value", path: position.path.join("."), rule: ruleName(rule) };
  }
  return workflowJsonDigest(copy) === reviewed.fixed_arguments_digest
    ? null
    : { kind: "arguments" };
}

export function mcpBoundaryViolation(
  boundary: McpBoundary,
  call: McpToolCall,
): McpBoundaryViolation | null {
  const shape = mcpArgumentsViolation(boundary, call);
  if (shape) return shape;
  if (!call.descriptor) return { kind: "descriptor_missing" };
  const observed = ToolDescriptorPinSchema.safeParse(call.descriptor);
  if (
    !observed.success ||
    observed.data.name !== boundary.tool ||
    observed.data.digest !== descriptorDigest(observed.data) ||
    observed.data.digest !== boundary.descriptor.digest
  )
    return { kind: "descriptor_changed" };
  return null;
}

export function describeMcpBoundaryViolation(violation: McpBoundaryViolation): string {
  switch (violation.kind) {
    case "tool":
      return "the tool name is not the one that was reviewed";
    case "argument_value":
      return `the argument \`${violation.path}\` is outside its rule (${violation.rule})`;
    case "arguments":
      return "the arguments differ from the reviewed call in more than their declared variables";
    case "descriptor_missing":
      return "the server no longer lists this tool, so what it does cannot be compared with the review";
    case "descriptor_changed":
      return "the server now describes this tool differently than when it was reviewed";
    default:
      return "the tool call could not be compared with its boundary";
  }
}

export function assertMcpBoundary(boundary: McpBoundary, call: McpToolCall): void {
  if (mcpBoundaryViolation(boundary, call) !== null)
    throw Object.assign(
      new Error("Tool call differs from its reviewed tool, arguments or description"),
      {
        code: "execution_authority_changed",
      },
    );
}
