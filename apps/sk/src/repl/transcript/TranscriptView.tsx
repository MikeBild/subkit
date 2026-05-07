// Orchestrator wrapper around VirtualTranscript.
//
// Adapts the existing transcript reducer (id-keyed list of message
// items) to VirtualTranscript's prop shape, computes per-item heights
// from the ink-markdown rendered output, and pins to the bottom by
// default. Callers pass in a renderItem callback that knows how to
// render each message kind (user, assistant, tool-call card, error
// panel, etc.); this component owns no message-shape knowledge.

import { useTheme } from "@chat-ui/index.ts";
import { Box } from "ink";
import { useMemo } from "react";
import { VirtualTranscript } from "../../shell/VirtualTranscript.tsx";

export interface TranscriptItem {
  id: string;
  /** Estimated row height for the rendered item. Caller is best
   *  positioned to estimate (we don't introspect rendered output). */
  estimatedHeight: number;
  /** Identity-stable React node for the item. */
  node: React.ReactNode;
}

export interface TranscriptViewProps {
  items: TranscriptItem[];
  /** Available rows for the transcript window. */
  viewportHeight: number;
  /** Available columns. Used as the cache key for height memoization. */
  width: number;
  /** Pin to the most recent items. Defaults to true. */
  stickyBottom?: boolean;
}

export function TranscriptView({
  items,
  viewportHeight,
  width,
  stickyBottom = true,
}: TranscriptViewProps): React.ReactElement {
  const tokens = useTheme();
  const getKey = useMemo(
    () =>
      (i: TranscriptItem): string =>
        i.id,
    [],
  );
  const estimateHeight = useMemo(
    () =>
      (i: TranscriptItem): number =>
        Math.max(1, Math.floor(i.estimatedHeight)),
    [],
  );
  const renderItem = useMemo(
    () =>
      (i: TranscriptItem): React.ReactNode =>
        i.node,
    [],
  );

  if (items.length === 0) {
    return <Box />;
  }

  return (
    <VirtualTranscript<TranscriptItem>
      items={items}
      getKey={getKey}
      estimateHeight={estimateHeight}
      renderItem={renderItem}
      viewportHeight={viewportHeight}
      width={width}
      stickyBottom={stickyBottom}
    />
  );
}
