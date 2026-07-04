import { Box, Text } from "ink";
import type React from "react";

interface Props {
  query: string;
  active: boolean;
  matches: number;
  total: number;
}

export const SearchInput: React.FC<Props> = ({ query, active, matches, total }) => {
  if (!active && query === "") return null;
  return (
    <Box marginTop={1}>
      <Text color={active ? "cyan" : "gray"}>/ </Text>
      <Text>{query}</Text>
      {active ? <Text inverse> </Text> : null}
      <Text color="gray">
        {"  "}({matches}/{total})
      </Text>
    </Box>
  );
};
