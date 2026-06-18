// Fuzzy-search picker for connector templates.
//
// Replaces the linear "scroll through 89 templates" UX from the
// onboarding wizard. Operators type a few characters; Fuse ranks the
// matches; arrow keys navigate the list; Enter selects.
//
// Render layout:
//   [icon]  name  ──────  category
//   …
//
// Icon is a single Unicode glyph chosen by category (no emoji to keep
// the line width predictable across terminals).

import { useTheme } from "@chat-ui/index.ts";
import Fuse from "fuse.js";
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";

export interface ConnectorTemplate {
  id: string;
  slug: string;
  display_name: string;
  category?: string;
  description?: string | null;
}

export interface IntegrationPickerProps {
  connectors: ConnectorTemplate[];
  onPick: (template: ConnectorTemplate) => void;
  onCancel?: () => void;
  /** Initial filter string. */
  initialQuery?: string;
  /** Maximum visible rows. Defaults to 8. */
  maxVisible?: number;
}

// CATEGORY_ICON moved to ./category-icons.ts so both surfaces (the
// fuzzy picker here and the onboarding wizard at
// `apps/sk/src/repl/onboarding-wizard.tsx`) share the same map.
import { categoryIconFor } from "./category-icons.ts";

function iconFor(template: ConnectorTemplate): string {
  return categoryIconFor(template.category);
}

export function IntegrationPicker({
  connectors,
  onPick,
  onCancel,
  initialQuery = "",
  maxVisible = 8,
}: IntegrationPickerProps): React.ReactElement {
  const tokens = useTheme();
  const [query, setQuery] = useState(initialQuery);
  const [cursor, setCursor] = useState(0);

  const fuse = useMemo(
    () =>
      new Fuse(connectors, {
        keys: [
          { name: "display_name", weight: 3 },
          { name: "slug", weight: 2 },
          { name: "category", weight: 1 },
          { name: "description", weight: 0.5 },
        ],
        threshold: 0.4,
        ignoreLocation: true,
      }),
    [connectors],
  );

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return connectors.slice(0, 50);
    return fuse.search(q, { limit: 50 }).map((r) => r.item);
  }, [connectors, fuse, query]);

  const visible = filtered.slice(0, maxVisible);
  const safeCursor = Math.min(cursor, Math.max(0, visible.length - 1));

  useInput((input, key) => {
    if (key.escape) {
      onCancel?.();
      return;
    }
    if (key.return) {
      const pick = visible[safeCursor];
      if (pick) onPick(pick);
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(visible.length - 1, c + 1));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setCursor(0);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setQuery((q) => q + input);
      setCursor(0);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={tokens.accent.primary} bold>
          ▸ pick a connector
        </Text>
        <Text color={tokens.severity.dim}> — type to filter, enter selects, esc cancels</Text>
      </Box>
      <Box>
        <Text color={tokens.severity.dim}>filter: </Text>
        <Text color={tokens.emphasis.strong}>{query || " "}</Text>
      </Box>
      {visible.length === 0 ? (
        <Box paddingLeft={2} marginTop={1}>
          <Text color={tokens.severity.dim}>no connectors match — try a shorter query</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {visible.map((c, i) => {
            const active = i === safeCursor;
            const color = active ? tokens.accent.primary : tokens.emphasis.normal;
            return (
              <Box key={c.id} flexDirection="row">
                <Text color={active ? tokens.accent.primary : tokens.severity.dim}>
                  {active ? "▶" : " "}
                </Text>
                <Text> </Text>
                <Text color={tokens.gutter.tool}>{iconFor(c)}</Text>
                <Text> </Text>
                <Text color={color} bold={active}>
                  {c.display_name}
                </Text>
                {c.category ? <Text color={tokens.severity.dim}> — {c.category}</Text> : null}
              </Box>
            );
          })}
          {filtered.length > visible.length ? (
            <Box paddingLeft={2}>
              <Text color={tokens.severity.dim}>
                … {filtered.length - visible.length} more — keep typing to narrow
              </Text>
            </Box>
          ) : null}
        </Box>
      )}
    </Box>
  );
}
