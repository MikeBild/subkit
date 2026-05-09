// Generic numbered consent prompt — `1. Yes · 2. Not now`. Pressing
// the digit confirms; pressing Esc cancels (treated as "Not now").
//
// Designed to be reused from any place a reversible consent decision
// is needed (memory capture, install picker, permissions selector).

import { Box, Text, useInput } from "ink";
import type React from "react";

interface Props {
  title: string;
  body?: string;
  yesLabel?: string;
  noLabel?: string;
  onYes: () => void;
  onNo: () => void;
}

export const ConsentPrompt: React.FC<Props> = ({
  title,
  body,
  yesLabel = "Yes",
  noLabel = "Not now",
  onYes,
  onNo,
}) => {
  useInput((input, key) => {
    if (input === "1") {
      onYes();
      return;
    }
    if (input === "2" || key.escape) {
      onNo();
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{title}</Text>
      {body ? <Text color="gray">{body}</Text> : null}
      <Box marginTop={1}>
        <Text color="cyan">1. </Text>
        <Text>{yesLabel}</Text>
        <Text color="gray"> · </Text>
        <Text color="cyan">2. </Text>
        <Text>{noLabel}</Text>
      </Box>
    </Box>
  );
};
