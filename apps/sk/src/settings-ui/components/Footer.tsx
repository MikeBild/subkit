import { Box, Text } from "ink";
import type React from "react";

interface Props {
  editing: boolean;
}

export const Footer: React.FC<Props> = ({ editing }) => {
  if (editing) {
    return (
      <Box>
        <Text color="gray">Enter</Text>
        <Text> commit </Text>
        <Text color="gray">Esc</Text>
        <Text> cancel </Text>
        <Text color="gray">Ctrl-R</Text>
        <Text> reveal secret</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text color="gray">Tab</Text>
      <Text> next section </Text>
      <Text color="gray">↑/↓</Text>
      <Text> select </Text>
      <Text color="gray">Enter</Text>
      <Text> edit </Text>
      <Text color="gray">Esc/q</Text>
      <Text> exit</Text>
    </Box>
  );
};
