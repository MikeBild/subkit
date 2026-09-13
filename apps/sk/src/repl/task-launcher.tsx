import { Pane, useTheme } from "@chat-ui/index.ts";
import { Box, Text, useInput } from "ink";
import type React from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { searchTaskActions, type TaskAction } from "./task-actions.ts";

interface TaskLauncherProps {
  actions: readonly TaskAction[];
  onSelect: (action: TaskAction) => void;
  onDismiss: () => void;
  inputDisabled?: boolean | undefined;
}

const CATEGORY_LABEL: Record<TaskAction["category"], string> = {
  start: "Start",
  authoring: "Authoring",
  execution: "Execution",
  review: "Review",
  context: "Context",
  admin: "Admin",
  utility: "Utility",
};

export const TaskLauncher: React.FC<TaskLauncherProps> = memo(
  ({ actions, onSelect, onDismiss, inputDisabled }) => {
    const theme = useTheme();
    const [query, setQuery] = useState("");
    const [cursor, setCursor] = useState(0);
    const matches = useMemo(() => searchTaskActions(query, actions, 10), [actions, query]);
    const matchesRef = useRef(matches);
    const cursorRef = useRef(cursor);
    useEffect(() => {
      matchesRef.current = matches;
      cursorRef.current = cursor;
    }, [matches, cursor]);

    useInput(
      (input, key) => {
        if (key.escape) {
          onDismiss();
          return;
        }
        if (!key.ctrl && !key.meta && input >= "1" && input <= "9") {
          const picked = matchesRef.current[input.charCodeAt(0) - "1".charCodeAt(0)];
          if (picked) onSelect(picked);
          return;
        }
        if (key.upArrow) {
          setCursor((idx) =>
            matches.length === 0 ? 0 : (idx - 1 + matches.length) % matches.length,
          );
          return;
        }
        if (key.downArrow || key.tab) {
          setCursor((idx) => (matches.length === 0 ? 0 : (idx + 1) % matches.length));
          return;
        }
        if (key.return || input === "\r" || input === "\n") {
          const picked = matchesRef.current[cursorRef.current] ?? matchesRef.current[0];
          if (picked) onSelect(picked);
          return;
        }
        if (key.backspace || key.delete) {
          setQuery((current) => current.slice(0, -1));
          setCursor(0);
          return;
        }
        if (!key.ctrl && !key.meta && input.length === 1) {
          const code = input.charCodeAt(0);
          if (code >= 0x20 && code !== 0x7f) {
            setQuery((current) => current + input);
            setCursor(0);
          }
        }
      },
      { isActive: !inputDisabled },
    );

    return (
      <Pane
        title="actions"
        subtitle="type to filter, Enter to run, Esc to close"
        onDismiss={onDismiss}
      >
        <Box flexDirection="column">
          <Text>
            <Text color={theme.severity.dim}>filter: </Text>
            {query.length > 0 ? query : <Text color={theme.severity.dim}>all actions</Text>}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {matches.length === 0 ? (
              <Text color={theme.severity.dim}>No matching action.</Text>
            ) : (
              matches.map((action, idx) => {
                const selected = idx === cursor;
                return (
                  <Box key={action.id} flexDirection="column" marginBottom={1}>
                    <Text {...(selected ? { color: theme.role.user } : {})}>
                      {selected ? "> " : "  "}
                      {idx + 1}. <Text bold>{action.label}</Text>
                      <Text color={theme.severity.dim}> - {action.detail}</Text>
                    </Text>
                    <Text color={theme.severity.dim}>
                      {"  "}
                      {CATEGORY_LABEL[action.category]} - {action.description}
                    </Text>
                  </Box>
                );
              })
            )}
          </Box>
        </Box>
      </Pane>
    );
  },
);

TaskLauncher.displayName = "TaskLauncher";
