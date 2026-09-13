import { Box, Text, useInput } from "ink";
import type React from "react";

import { resolveAction } from "../keybindings/useKeybinding.ts";

interface Props {
  title: string;
  body: string;
  confirmLabel?: string;
  onYes: () => void;
  onNo: () => void;
}

export const ConfirmModal: React.FC<Props> = ({
  title,
  body,
  confirmLabel = "force=true",
  onYes,
  onNo,
}) => {
  useInput((input, key) => {
    const action = resolveAction("Confirm", input, key);
    if (action === "confirm:yes") onYes();
    else if (action === "confirm:no") onNo();
  });

  return (
    <Box borderStyle="double" borderColor="red" padding={1} flexDirection="column" marginTop={1}>
      <Text bold color="red">
        {title}
      </Text>
      <Text>{body}</Text>
      <Box marginTop={1}>
        <Text color="gray">Press </Text>
        <Text bold color="green">
          Y
        </Text>
        <Text color="gray"> to retry with </Text>
        <Text>{confirmLabel}</Text>
        <Text color="gray"> · </Text>
        <Text bold color="yellow">
          N / Esc
        </Text>
        <Text color="gray"> to cancel</Text>
      </Box>
    </Box>
  );
};
