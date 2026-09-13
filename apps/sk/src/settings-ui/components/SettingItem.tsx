import { Box, Text } from "ink";
import type React from "react";

import { labelForPath } from "../lib/config-labels.ts";
import type { FormField } from "../lib/zod-to-form-fields.ts";

interface Props {
  field: FormField;
  selected: boolean;
}

function renderValue(field: FormField): string {
  if (field.sensitive) {
    if (field.value === "" || field.value === null || field.value === undefined) return "";
    return "•••";
  }
  return JSON.stringify(field.value);
}

export const SettingItem: React.FC<Props> = ({ field, selected }) => {
  const cursor = selected ? "▸" : " ";
  const sourceColor =
    field.source === "override"
      ? "magenta"
      : field.source === "tenant"
        ? "yellow"
        : field.source === "global"
          ? "green"
          : "gray";
  const label = labelForPath(field.path);
  return (
    <Box>
      {selected ? <Text color="cyan">{cursor} </Text> : <Text>{cursor} </Text>}
      <Box width={44}>
        {selected ? (
          <Text color="cyan" bold>
            {label}
          </Text>
        ) : (
          <Text>{label}</Text>
        )}
      </Box>
      <Box width={28}>
        <Text>{renderValue(field).slice(0, 26)}</Text>
      </Box>
      <Text color={sourceColor}>{`[${field.source}]`}</Text>
      {field.sensitive ? <Text color="yellow"> secret</Text> : null}
      {field.requiresRestart ? <Text color="red"> restart</Text> : null}
    </Box>
  );
};
