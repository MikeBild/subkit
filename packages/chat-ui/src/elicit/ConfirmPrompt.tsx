import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import { StructuredDiff } from "../diff/StructuredDiff.tsx";
import { renderTextWithLinks } from "../hyperlink.ts";
import { useTheme } from "../theme/Provider.tsx";
import { ControlledTextField } from "./ControlledTextField.tsx";

export type ConfirmKind = "save_workflow_draft" | "external_write" | "generic";

export interface ConfirmPromptProps {
  question: string;
  summary?: string | undefined;
  kind?: ConfirmKind | undefined;
  diff?: unknown;
  target?: unknown;
  destructive?: boolean | undefined;
  defaultChoice?: "approve" | "reject" | undefined;
  riskLevel?: "low" | "medium" | "high" | "critical" | string | undefined;
  targetLabel?: string | undefined;
  reversible?: boolean | undefined;
  pendingOutput?: Record<string, unknown> | undefined;
  onResponse: (value: { confirmed: boolean; feedback?: string }) => void;
  inputDisabled?: boolean | undefined;
}

function isPrintable(input: string, key: { ctrl: boolean; meta: boolean }): boolean {
  if (key.ctrl || key.meta) return false;
  if (input.length !== 1) return false;
  const code = input.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

function describePendingValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return `[${value.length}] ${value.slice(0, 3).join(", ")}`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    return keys.length > 0 ? `{${keys.slice(0, 4).join(", ")}}` : "{}";
  }
  return String(value);
}

function compactText(value: string, maxChars: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > maxChars
    ? `${singleLine.slice(0, Math.max(0, maxChars - 1))}…`
    : singleLine;
}

function readString(
  obj: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function describeTarget(target: unknown): string {
  if (typeof target === "string") return compactText(target, 160);
  if (target && typeof target === "object") {
    const obj = target as Record<string, unknown>;
    const args =
      obj.args && typeof obj.args === "object" ? (obj.args as Record<string, unknown>) : {};
    const tool = typeof obj.tool === "string" && obj.tool.trim() ? obj.tool.trim() : null;
    if (tool) {
      const idHint = readString(args, [
        "target_workflow_id",
        "workflow_id",
        "workflow",
        "slug",
        "connector_id",
        "id",
      ]);
      const environment = readString(args, ["environment"]);
      const parts = [tool, idHint, environment ? `env=${environment}` : null].filter(Boolean);
      return compactText(parts.join(" "), 160);
    }
    const method = readString(obj, ["method"]);
    const url = readString(obj, ["url", "path"]);
    if (url) return compactText(method ? `${method} ${url}` : url, 160);
    return compactText(`{${Object.keys(obj).slice(0, 5).join(", ")}}`, 160);
  }
  return compactText(String(target), 160);
}

export const ConfirmPrompt: React.FC<ConfirmPromptProps> = ({
  question,
  summary,
  kind = "generic",
  diff,
  target,
  destructive,
  defaultChoice,
  riskLevel,
  targetLabel,
  reversible,
  pendingOutput,
  onResponse,
  inputDisabled,
}) => {
  const theme = useTheme();
  const initialFocus = destructive || defaultChoice === "reject" ? 1 : 0;
  const [focused, setFocused] = useState<0 | 1>(initialFocus);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");

  const submit = (confirmed: boolean): void => {
    const out: { confirmed: boolean; feedback?: string } = { confirmed };
    const trimmed = reason.trim();
    if (trimmed) out.feedback = trimmed;
    onResponse(out);
  };

  useInput(
    (input, key) => {
      if (reasonOpen) {
        if (key.escape || key.tab) {
          setReasonOpen(false);
          return;
        }
        if (key.return) {
          setReasonOpen(false);
          return;
        }
        if (key.backspace || key.delete) {
          setReason((r) => r.slice(0, -1));
          return;
        }
        if (isPrintable(input, key)) {
          setReason((r) => r + input);
        }
        return;
      }

      const lower = input.toLowerCase();
      if (input === "1" || lower === "y" || lower === "a") submit(true);
      else if (input === "3" || lower === "n" || lower === "r") submit(false);
      else if (key.leftArrow) setFocused(0);
      else if (key.rightArrow) setFocused(1);
      else if (key.tab) setReasonOpen(true);
      else if (key.return) submit(focused === 0);
      else if (key.escape) submit(false);
    },
    { isActive: !inputDisabled },
  );

  const titleColor = destructive ? theme.emphasis.destructive : theme.severity.warning;
  const kindLabel = destructive ? `${kind} (DESTRUCTIVE)` : kind;
  const displaySummary = summary ? compactText(summary, 360) : undefined;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={titleColor}
      paddingX={1}
      marginY={1}
    >
      <Text color={titleColor} bold>
        confirm: {kindLabel}
      </Text>
      <Text bold>{question}</Text>
      {displaySummary && displaySummary !== question.trim() ? (
        <Text>{renderTextWithLinks(displaySummary)}</Text>
      ) : null}
      {riskLevel || targetLabel || reversible !== undefined ? (
        <Box flexDirection="column" marginTop={1}>
          {riskLevel ? (
            <Text>
              <Text color={theme.severity.dim}>risk: </Text>
              {riskLevel}
            </Text>
          ) : null}
          {targetLabel ? (
            <Text>
              <Text color={theme.severity.dim}>target: </Text>
              {targetLabel}
            </Text>
          ) : null}
          {reversible !== undefined ? (
            <Text>
              <Text color={theme.severity.dim}>reversible: </Text>
              {reversible ? "yes" : "no"}
            </Text>
          ) : null}
        </Box>
      ) : null}
      {pendingOutput && Object.keys(pendingOutput).length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {Object.entries(pendingOutput).map(([key, value]) => (
            <Text key={key}>
              <Text color={theme.severity.dim}>{key}: </Text>
              {describePendingValue(value)}
            </Text>
          ))}
        </Box>
      ) : null}
      {kind === "external_write" && target !== undefined ? (
        <Text>
          <Text color={theme.severity.dim}>target: </Text>
          {describeTarget(target)}
        </Text>
      ) : null}
      {diff !== undefined ? <StructuredDiff diff={diff} /> : null}
      <Box>
        <Text {...(focused === 0 ? { color: theme.role.user } : {})}>
          {focused === 0 ? "▶ " : "  "}1. Approve
        </Text>
        <Text> </Text>
        <Text {...(focused === 1 ? { color: theme.role.user } : {})}>
          {focused === 1 ? "▶ " : "  "}3. Reject
        </Text>
      </Box>
      {reasonOpen && !inputDisabled ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.severity.dim}>reason (optional):</Text>
          <ControlledTextField value={reason} focused={true} placeholder="why?" />
          <Text color={theme.severity.dim}>Enter to keep · Tab/Esc to close</Text>
        </Box>
      ) : (
        <Text color={theme.severity.dim}>
          y/Enter to approve · n/Esc to reject · ←→ to focus · Tab for reason
          {reason.trim() ? ` · reason: "${reason.trim()}"` : ""}
        </Text>
      )}
    </Box>
  );
};
