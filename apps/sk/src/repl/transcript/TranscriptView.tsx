import { useTheme } from "@chat-ui/index.ts";
import { Box } from "ink";
import { useMemo } from "react";
import { VirtualTranscript } from "../../shell/VirtualTranscript.tsx";

export interface TranscriptItem {
  id: string;
  estimatedHeight: number;
  node: React.ReactNode;
}

export interface TranscriptViewProps {
  items: TranscriptItem[];
  viewportHeight: number;
  width: number;
  stickyBottom?: boolean;
}

export function TranscriptView({
  items,
  viewportHeight,
  width,
  stickyBottom = true,
}: TranscriptViewProps): React.ReactElement {
  const _tokens = useTheme();
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
