import { Text } from "ink";
import type React from "react";
import { useTheme } from "../theme/Provider.tsx";

export interface ControlledTextFieldProps {
  value: string;
  focused: boolean;
  placeholder?: string | undefined;
  mask?: "none" | "password" | undefined;
}

export const ControlledTextField: React.FC<ControlledTextFieldProps> = ({
  value,
  focused,
  placeholder,
  mask = "none",
}) => {
  const theme = useTheme();
  const display = mask === "password" ? "•".repeat(value.length) : value;
  const isEmpty = value.length === 0;

  if (!focused) {
    return <Text color={theme.severity.dim}>{isEmpty ? (placeholder ?? "") : display}</Text>;
  }

  if (isEmpty) {
    return (
      <Text>
        <Text inverse> </Text>
        <Text color={theme.severity.dim}>{placeholder ? ` ${placeholder}` : ""}</Text>
      </Text>
    );
  }

  return (
    <Text>
      {display}
      <Text inverse> </Text>
    </Text>
  );
};
