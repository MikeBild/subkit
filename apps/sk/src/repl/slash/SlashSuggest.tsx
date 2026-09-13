// Inline slash-command suggestion panel.
//
// Replaces the implicit "type `/` and hope you remember the name"
// discoverability gap with:
//   - a hint row when the prompt is empty ("press / to discover N
//     commands"),
//   - an inline highlight on the typed slash token (color depends on
//     whether it resolves to a command for the persona),
//   - an autocomplete list while the cursor is on a slash token,
//     ranked by `searchSlashCommands` (prefix + persona filter).
//
// The panel is purely visual; it doesn't dispatch the command itself —
// the input handler decides what to do when Enter or Tab is pressed.

import { useTheme } from "@chat-ui/index.ts";
import { Box, Text } from "ink";
import { useMemo } from "react";

import { type PersonaProbe, searchSlashCommands, type SlashCommand } from "../../slash.ts";
import { spanAtCursor } from "./findPositions.ts";
import { resolveSlashCommand } from "./hasCommand.ts";

export interface SlashSuggestProps {
  /** Current prompt buffer. */
  buffer: string;
  /** Cursor position (UTF-16 offset within buffer). */
  cursor: number;
  /** Active persona — gates the visible command set. */
  persona: PersonaProbe;
  /** Maximum suggestions to display. Defaults to 6. */
  maxSuggestions?: number;
  /** When true, show the welcome hint when the buffer is empty.
   *  Defaults to true. */
  showWelcomeHint?: boolean;
  /** Highlight color override for the active slash token. */
  highlightColor?: string;
}

export function SlashSuggest({
  buffer,
  cursor,
  persona,
  maxSuggestions = 6,
  showWelcomeHint = true,
  highlightColor,
}: SlashSuggestProps): React.ReactElement | null {
  const tokens = useTheme();

  // Rules-of-hooks. Both `useMemo` calls below
  // were originally placed AFTER the `buffer.length === 0` early
  // return, which meant the hook count jumped from 1 to 3 when the
  // user typed the first character — corrupting React's hook table.
  // Hoisting both calls above any early return keeps the count
  // stable across renders. The empty-buffer branch still returns the
  // welcome hint; the memos run unconditionally with whatever buffer
  // value React last committed.
  const span = useMemo(() => spanAtCursor(buffer, cursor), [buffer, cursor]);
  const ranked = useMemo(
    () => (span ? searchSlashCommands(span.name, persona, maxSuggestions) : []),
    [span, persona, maxSuggestions],
  );

  // Empty buffer: welcome hint. Computed locally so it doesn't open
  // a new hook scope; `searchSlashCommands` is pure.
  if (buffer.length === 0) {
    if (!showWelcomeHint) return null;
    const visibleCount = searchSlashCommands("", persona, 999).length;
    return (
      <Box flexDirection="row">
        <Text color={tokens.severity.dim}>
          press <Text color={tokens.accent.primary}>/</Text> to browse {visibleCount} command
          {visibleCount === 1 ? "" : "s"}
        </Text>
      </Box>
    );
  }

  // Cursor is not inside a slash span — render nothing.
  if (!span) return null;

  const highlighted = highlightForName(span.name, persona, tokens, highlightColor);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={tokens.severity.dim}>›</Text>
        <Text> </Text>
        {highlighted}
        {span.name.length > 0 ? null : <Text color={tokens.severity.dim}>(type to filter)</Text>}
      </Box>
      {ranked.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {ranked.map((cmd) => (
            <SuggestionRow key={cmd.name} cmd={cmd} query={span.name} />
          ))}
        </Box>
      ) : (
        <Box paddingLeft={2}>
          <Text color={tokens.severity.dim}>no matching commands</Text>
        </Box>
      )}
    </Box>
  );
}

function highlightForName(
  name: string,
  persona: PersonaProbe,
  tokens: ReturnType<typeof useTheme>,
  override?: string,
): React.ReactElement {
  const resolved = resolveSlashCommand(name);
  let color: string;
  if (override) {
    color = override;
  } else if (!resolved) {
    color = tokens.severity.dim;
  } else if (resolved.requires && !persona.allows(resolved.requires)) {
    color = tokens.severity.warning;
  } else {
    color = tokens.accent.primary;
  }
  return (
    <Text color={color} bold>
      /{name}
    </Text>
  );
}

function SuggestionRow({ cmd, query }: { cmd: SlashCommand; query: string }): React.ReactElement {
  const tokens = useTheme();
  const matchPos = query ? cmd.name.toLowerCase().indexOf(query.toLowerCase()) : -1;
  let nameNode: React.ReactNode;
  if (matchPos >= 0) {
    const before = cmd.name.slice(0, matchPos);
    const hit = cmd.name.slice(matchPos, matchPos + query.length);
    const after = cmd.name.slice(matchPos + query.length);
    nameNode = (
      <Text color={tokens.accent.primary}>
        /{before}
        <Text color={tokens.accent.secondary} bold>
          {hit}
        </Text>
        {after}
      </Text>
    );
  } else {
    nameNode = <Text color={tokens.accent.primary}>/{cmd.name}</Text>;
  }
  return (
    <Box flexDirection="row">
      {nameNode}
      <Text color={tokens.severity.dim}> — {cmd.help}</Text>
    </Box>
  );
}
