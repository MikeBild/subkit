import type { ToolCallState, ToolLogEntry } from "@cli-core/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";

const BACKGROUND_TOOL_NAMES = new Set([
  "load_skill",
  "web_search",
  "search_knowledge",
  "search_docs",
  "find_tool",
  "find_system",
  "find_system_templates",
  "inspect_tool",
  "inspect_system",
  "list_workflows",
  "list_connectors",
  "list_skills",
  "list_skill_suggestions",
  "list_knowledge_sources",
  "list_executions",
  "list_runs",
]);

const BACKGROUND_TOOL_PREFIXES = ["list_", "search_", "find_", "inspect_", "read_"] as const;

function humanize(name: string): string {
  return name.replace(/_/g, " ");
}

function compactName(name: string): string {
  switch (name) {
    case "web_search":
      return "searched web";
    case "search_knowledge":
      return "searched knowledge";
    case "search_docs":
      return "read documentation";
    case "load_skill":
      return "loaded skills";
    default:
      return name;
  }
}

export function isBackgroundTool(call: ToolCallState): boolean {
  if (call.status === "failed") return false;
  if (BACKGROUND_TOOL_NAMES.has(call.name)) return true;
  return BACKGROUND_TOOL_PREFIXES.some((prefix) => call.name.startsWith(prefix));
}

interface BackgroundToolGroupProps {
  calls: readonly ToolCallState[];
  logs: readonly ToolLogEntry[];
  detailed: boolean;
}

const BackgroundToolGroupImpl: React.FC<BackgroundToolGroupProps> = ({ calls, logs, detailed }) => {
  if (calls.length === 0) return null;
  const active = calls.some((call) => call.status === "running" || call.status === "pending");
  const labels = Array.from(new Set(calls.map((call) => compactName(call.name))));
  const summary = labels.join(" · ");
  const activeCount = calls.filter(
    (call) => call.status === "running" || call.status === "pending",
  ).length;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text dimColor>· </Text>
        <Text>{active ? "background actions running" : "background actions"}</Text>
        <Text dimColor>
          {" "}
          · {calls.length} total{activeCount > 0 ? ` · ${activeCount} active` : ""}
        </Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>{summary}</Text>
      </Box>
      {detailed
        ? calls.map((call) => (
            <Box key={call.id} marginLeft={2}>
              <Text dimColor>
                {call.status === "running" ? "↻" : "✓"} {humanize(call.name)}
              </Text>
            </Box>
          ))
        : null}
      {logs.map((log, index) => (
        <Box key={`${log.call_id}-${index}`} marginLeft={2}>
          <Text dimColor>
            [{log.level}] {log.message}
          </Text>
        </Box>
      ))}
    </Box>
  );
};

export const BackgroundToolGroup = memo(BackgroundToolGroupImpl);
