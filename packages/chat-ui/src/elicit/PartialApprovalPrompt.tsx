import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import { useTheme } from "../theme/Provider.tsx";

export interface PartialDiffEntry {
  label: string;
  preview?: string;
}

export interface PartialApprovalPromptProps {
  question: string;
  diffs: PartialDiffEntry[];
  onResponse: (value: {
    confirmed: boolean;
    partial?: boolean;
    approved_indices?: number[];
    decision_reason?: string;
  }) => void;
  inputDisabled?: boolean | undefined;
}

export const PartialApprovalPrompt: React.FC<PartialApprovalPromptProps> = ({
  question,
  diffs,
  onResponse,
  inputDisabled,
}) => {
  const theme = useTheme();
  const [focused, setFocused] = useState(0);
  const [approved, setApproved] = useState<Set<number>>(() => new Set(diffs.map((_, i) => i)));

  useInput(
    (input, key) => {
      if (diffs.length === 0) return;
      if (key.upArrow) setFocused((i) => (i - 1 + diffs.length) % diffs.length);
      else if (key.downArrow) setFocused((i) => (i + 1) % diffs.length);
      else if (input === " ") {
        setApproved((prev) => {
          const next = new Set(prev);
          if (next.has(focused)) next.delete(focused);
          else next.add(focused);
          return next;
        });
      } else if (input === "a") {
        setApproved(new Set(diffs.map((_, i) => i)));
      } else if (input === "r") {
        setApproved(new Set());
      } else if (key.return) {
        const approvedIndices = [...approved].sort((a, b) => a - b);
        const allApproved = approvedIndices.length === diffs.length;
        const noneApproved = approvedIndices.length === 0;
        if (noneApproved) {
          onResponse({ confirmed: false });
          return;
        }
        onResponse({
          confirmed: true,
          partial: !allApproved,
          approved_indices: approvedIndices,
        });
      } else if (key.escape) {
        onResponse({ confirmed: false, decision_reason: "user_cancelled" });
      }
    },
    { isActive: !inputDisabled },
  );

  const approvedCount = approved.size;
  const rejectedCount = diffs.length - approvedCount;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.severity.info} paddingX={1}>
      <Text bold>
        {question}{" "}
        <Text color={theme.severity.dim}>
          ({approvedCount} approved · {rejectedCount} rejected)
        </Text>
      </Text>
      {diffs.map((d, i) => {
        const isFocused = i === focused;
        const isApproved = approved.has(i);
        const marker = isApproved ? "✓" : "✗";
        const markerColor = isApproved ? theme.severity.info : theme.severity.warning;
        return (
          <Box key={i} flexDirection="column">
            <Box>
              <Text {...(isFocused ? { color: theme.role.user } : {})}>
                {isFocused ? "▶ " : "  "}
              </Text>
              <Text color={markerColor} bold>
                [{marker}]{" "}
              </Text>
              <Text {...(isFocused ? { color: theme.role.user } : {})}>{d.label}</Text>
            </Box>
            {d.preview ? (
              <Box marginLeft={6}>
                <Text color={theme.severity.dim}>{d.preview}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      <Text color={theme.severity.dim}>
        ↑/↓ move · space toggle · a approve all · r reject all · Enter submit · Esc cancel
      </Text>
    </Box>
  );
};
