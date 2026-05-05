import { Box, Text } from "ink";
import type React from "react";

interface Props {
  editing: boolean;
  searching?: boolean;
  confirming?: boolean;
}

export const Footer: React.FC<Props> = ({ editing, searching, confirming }) => {
  if (confirming) {
    return (
      <Box>
        <Text color="gray">Y</Text>
        <Text> retry with force </Text>
        <Text color="gray">N/Esc</Text>
        <Text> cancel</Text>
      </Box>
    );
  }
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
  if (searching) {
    return (
      <Box>
        <Text color="gray">type</Text>
        <Text> filter </Text>
        <Text color="gray">Enter</Text>
        <Text> edit match </Text>
        <Text color="gray">Esc</Text>
        <Text> clear search</Text>
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
      <Text color="gray">/</Text>
      <Text> search </Text>
      <Text color="gray">Esc/q</Text>
      <Text> exit</Text>
    </Box>
  );
};
