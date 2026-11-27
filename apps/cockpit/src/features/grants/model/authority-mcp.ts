import { CLASS_KEYS } from "@/features/grants/model/authority-request";
import type { TranslationKey } from "@/lib/i18n";

type VariableRule = { enum: string[] } | { class: string } | { caller_bound: true };

export interface McpBoundaryView {
  server: string;
  tool: string;
  effect: "read" | "write";
  variables: Record<string, VariableRule>;
  arguments: Array<{ path: string[]; var: string }>;
  max_calls: number;
  descriptor: {
    name: string;
    annotations: {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint?: boolean;
    };
    input_schema_digest: string;
    digest: string;
  };
}

interface McpBoundaryPresentation {
  title: TranslationKey;
  stated: TranslationKey;
  hint: TranslationKey;
  unconfirmedRead: boolean;
  cautious: boolean;
  target: string;
  command: string | null;
  variables: Array<{ key: TranslationKey; values: Record<string, string> }>;
  fixed: TranslationKey;
  calls: number;
  descriptor: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mcpBoundaryOf(effect: unknown): McpBoundaryView | null {
  const candidate = isRecord(effect) ? effect.mcp : null;
  if (!isRecord(candidate) || !isRecord(candidate.descriptor)) return null;
  if (typeof candidate.tool !== "string" || typeof candidate.server !== "string") return null;
  if (!isRecord(candidate.variables) || !Array.isArray(candidate.arguments)) return null;
  if (typeof candidate.max_calls !== "number") return null;
  if (typeof candidate.descriptor.digest !== "string") return null;
  return candidate as unknown as McpBoundaryView;
}

export function presentMcpBoundary(
  boundary: McpBoundaryView,
  comparedWithServer = false,
  command: string | null = null,
): McpBoundaryPresentation {
  const localCommand = boundary.server.startsWith("stdio:") ? command : null;
  const hints = isRecord(boundary.descriptor.annotations) ? boundary.descriptor.annotations : {};
  const statedRead = boundary.effect === "read";
  const describesReadOnly = hints.readOnlyHint === true && hints.destructiveHint !== true;
  const kind =
    hints.destructiveHint === true
      ? "Destructive"
      : hints.readOnlyHint === true
        ? "ReadOnly"
        : hints.readOnlyHint === false
          ? "Changes"
          : "None";
  const hint: TranslationKey = comparedWithServer
    ? `authority.mcp.hint${kind}`
    : `authority.mcp.recorded${kind}`;
  let unknownRule = false;
  const variables = boundary.arguments.map(
    (position): McpBoundaryPresentation["variables"][number] => {
      const name = position.path.join(".");
      const rule = boundary.variables[position.var];
      if (rule && "enum" in rule)
        return {
          key: "authority.boundary.variable",
          values: { name, values: rule.enum.join(", ") },
        };
      if (rule && "caller_bound" in rule)
        return { key: "authority.boundary.callerBound", values: { name } };
      const key = rule ? CLASS_KEYS[rule.class] : undefined;
      if (key) return { key, values: { name } };
      unknownRule = true;
      return {
        key: "authority.boundary.unknownRule",
        values: { name, rule: rule ? String(rule.class) : "?" },
      };
    },
  );
  return {
    title: statedRead ? "authority.mcp.read" : "authority.mcp.write",
    stated: statedRead ? "authority.mcp.statedRead" : "authority.mcp.statedWrite",
    hint,
    unconfirmedRead: statedRead && !describesReadOnly,
    cautious: unknownRule || (statedRead && !describesReadOnly),
    target: `${localCommand ?? boundary.server} · ${boundary.tool}`,
    command: localCommand,
    variables,
    fixed: variables.length > 0 ? "authority.mcp.fixedArguments" : "authority.mcp.noVariables",
    calls: boundary.max_calls,
    descriptor: boundary.descriptor.digest.slice(0, 12),
  };
}
